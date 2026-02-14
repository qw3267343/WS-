# WAStack 全链路审计（wa-gateway + wa-panel-ui + electron）

> 目标链路：登录 / 状态 / 心跳 / 在线策略 / 角色绑定
> 说明：本报告仅定位与审计，不改业务代码。

---

## 1) Workspace(ws) 传递

### [wa-gateway/master] [wa-gateway/master.js:67-72] 关键代码片段
```js
function resolveWs(raw) {
  const s = String(raw || 'default').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'default';
}
function getWsFromReq(req) { return resolveWs(req.headers['x-ws'] || req.query?.ws || req.body?.ws || 'default'); }
```
- 作用：master 端 ws 统一入口，支持 `x-ws`、`?ws=`、`body.ws` 三路解析。
- 关联：被 `/api/accounts`、`/api/accounts/create`、`/api/roles`、`/api/roles/batch` 等直接调用。

### [wa-gateway/worker] [wa-gateway/server.js:485-488] 关键代码片段
```js
function getWs(req) {
  const raw = req.query?.ws || req.headers['x-ws'] || 'default';
  return resolveWs(raw);
}
```
- 作用：worker 端只解析 `query.ws` 与 `x-ws`，**不读 body.ws**。
- 关联：所有 worker API（accounts/roles/groups/send/schedule）都通过 `getWs(req)` 路由到 workspace。

### [wa-panel-ui/workspace来源] [wa-panel-ui/src/lib/workspace.ts:3-30] 关键代码片段
```ts
export function getWsId(): string {
  const params = new URLSearchParams(window.location.search);
  const wsFromQuery = (params.get("ws") || "").trim();
  if (wsFromQuery) return wsFromQuery;

  const hash = String(window.location.hash || "").trim();
  if (hash.includes("?")) {
    const q = hash.split("?").slice(1).join("?");
    const hp = new URLSearchParams(q);
    const wsFromHashQuery = (hp.get("ws") || "").trim();
    if (wsFromHashQuery) return wsFromHashQuery;
  }

  const hashMatch = hash.match(/#\/w\/([^\/?#]+)/);
  if (hashMatch?.[1]) return decodeURIComponent(hashMatch[1]);

  const pathMatch = String(window.location.pathname || "").match(/^\/w\/([^\/?#]+)/);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);

  const saved = localStorage.getItem(ACTIVE_WS_KEY);
  return (saved || "").trim() || "default";
}
```
- 作用：前端 ws 来源覆盖 query/hash/hash-router/browser-router/localStorage。
- 关联：被 API 拦截器、Socket 连接、页面路由共同复用。

### [wa-panel-ui/API层] [wa-panel-ui/src/lib/api.ts:22-33] 关键代码片段
```ts
http.interceptors.request.use((config) => {
  const wsId = getWsId();
  config.headers = config.headers ?? {};
  const h: any = config.headers as any;
  if (typeof h.set === "function") h.set("x-ws", wsId);
  else h["x-ws"] = wsId;

  if (config.url) {
    config.url = withWs(config.url);
  }
  return config;
});
```
- 作用：统一为每个 axios 请求加 `x-ws` 且补 `?ws=`。
- 关联：所有 `http.get/post/...` 页面请求都经过此拦截器。

### [electron] [electron/main.cjs:284-309] 关键代码片段
```js
function openProjectWindow(projectId) {
  const key = String(projectId || "").trim();
  if (!key) return null;
  return openOrFocusProjectWindow(key, `#/project?ws=${encodeURIComponent(key)}`);
}

ipcMain.handle("openProjectWindow", async (_event, payload = {}) => {
  const id = typeof payload === "string" ? payload : payload.id;
  const hash = typeof payload === "object" && payload ? payload.hash : undefined;
  const targetHash = hash || `#/project?ws=${encodeURIComponent(String(id || "").trim())}`;
  const opened = openOrFocusProjectWindow(id, targetHash);
  return Boolean(opened);
});
```
- 作用：Electron 新开项目窗口时会把 ws 注入 hash query。
- 关联：前端 `MasterPage.openProjectWindow`（IPC）触发此逻辑。

---

## 2) Accounts 静态数据存储

### [wa-gateway/master] [wa-gateway/master.js:82-107] 关键代码片段
```js
function wsDir(ws) { return path.join(CONFIG_ROOT, 'workspaces', ws); }
function wsLeaseFile(ws) { return path.join(wsDir(ws), 'slot_owner.json'); }

function accountsFile(ws) { return path.join(wsDir(ws), 'accounts.json'); }
function accountsLockFile(ws) { return `${accountsFile(ws)}.lock`; }
```
- 作用：master 的账号静态配置在 `CONFIG_ROOT/workspaces/<ws>/accounts.json`。
- 关联：`/api/accounts`、`/api/accounts/create` 直接读写该文件。

### [wa-gateway/master handler] [wa-gateway/master.js:546-585] 关键代码片段
```js
app.get('/api/accounts', (req, res) => {
  const ws = getWsFromReq(req);
  const rows = readJson(accountsFile(ws), []);
  return res.json({ ok: true, data: Array.isArray(rows) ? rows : [] });
});
app.post('/api/accounts/create', (req, res) => {
  // ...
  const uid = allocateNextUid(list);
  const acc = { slot, uid, sessionDir: buildSessionDir(uid), createdAt: Date.now(), enabled };
  list.push(acc);
  writeJson(accountsFile(ws), list);
  // ...
});
```
- 作用：master 维护账号坑位静态结构（slot/uid/sessionDir/enabled/createdAt）。
- 关联：前端 Accounts 页面 `create`/`list` 命中此处。

### [wa-gateway/worker数据层] [wa-gateway/server.js:757-765] 关键代码片段
```js
function loadAccounts(ws) {
  const file = getWorkspaceAccountsFile(ws);
  const data = readJson(file, []);
  const list = Array.isArray(data) ? data : [];
  return list.map((x) => {
    const uid = String(x?.uid || '').trim();
    const sessionDir = String(x?.sessionDir || '').trim() || (uid ? `session-${uid}` : '');
    return { ...x, uid, sessionDir, enabled: x?.enabled !== false };
  });
}
```
- 作用：worker 读入 accounts 时会补齐 sessionDir/default enabled。
- 关联：ensureClient/connect/delete/roles 校验都依赖此结构。

---

## 3) Worker 登录与会话

### [worker启动入口] [wa-gateway/master.js:370-401] 关键代码片段
```js
async function ensureWorkerRunning(worker, ws) {
  const workdir = path.join(WORK_ROOT, worker.id);
  ensureDir(workdir);
  const env = {
    ...process.env,
    PORT: String(worker.port),
    DATA_DIR: DATA_ROOT,
    CONFIGDIR: CONFIG_ROOT,
    WORKDIR: workdir,
    MASTER_INTERNAL_URL: `http://127.0.0.1:${PORT_MASTER}`,
    WORKER_ID: String(worker.id),
    WORKSPACE_ID: ws,
    MAX_ACTIVE: String(MAX_ACTIVE),
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: 'inherit' });
  // ...
}
```
- 作用：master 以子进程形式拉起 `server.js` worker。
- 关联：所有 `/api/accounts/:slot/*` 代理前会确保对应 worker 已启动。

### [登录库与会话目录] [wa-gateway/server.js:1196-1217] 关键代码片段
```js
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: uid,
    dataPath: authDir
  }),
  puppeteer: {
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  },
});
```
- 作用：worker 使用 `whatsapp-web.js + puppeteer`，LocalAuth 以 `uid` 作为 clientId；会话根目录来自 workspace authDir。
- 关联：accounts.json 的 `uid/sessionDir` 与 `ensureSessionCompat` 一起决定会话复用路径。

### [登录状态监听] [wa-gateway/server.js:1222-1253] 关键代码片段
```js
client.on('qr', (qr) => {
  statuses.set(slot, { status: 'QR', lastQr: qr });
  emitWsEvent(ws, 'wa:qr', { slot, uid, qr });
  emitWsEvent(ws, 'wa:status', { slot, uid, status: 'QR' });
});

client.on('ready', () => {
  // ...
  statuses.set(slot, { status: 'READY', lastQr: null });
  emitWsEvent(ws, 'wa:status', { slot, uid, status: 'READY', phone, nickname });
});

client.on('auth_failure', (msg) => {
  statuses.set(slot, { status: 'AUTH_FAILURE', lastQr: null });
  emitWsEvent(ws, 'wa:status', { slot, uid, status: 'AUTH_FAILURE', msg });
});

client.on('disconnected', (reason) => {
  statuses.set(slot, { status: 'DISCONNECTED', lastQr: null });
  emitWsEvent(ws, 'wa:status', { slot, uid, status: 'DISCONNECTED', reason });
});
```
- 作用：当前仅监听 `qr/ready/auth_failure/disconnected`。
- 关联：master 的 statusByWorker 与 UI socket 更新依赖这些上报。
- 风险：未监听 `authenticated/change_state`，状态粒度不完整。

---

## 4) Worker -> Master 状态上报

### [worker上报方式] [wa-gateway/server.js:1071-1078] 关键代码片段
```js
function emitWsEvent(ws, event, payload) {
  io.to(ws).emit(event, payload);
  if (!MASTER_INTERNAL_URL) return;
  postJson(`${MASTER_INTERNAL_URL}/internal/emit`, { ws, event, payload }, MASTER_TOKEN ? { 'x-master-token': MASTER_TOKEN } : {})
    .catch((e) => {
      log('warn', 'master_emit_failed', { ws, event, err: String(e?.message || e) });
    });
}
```
- 作用：worker 采用 HTTP POST 向 master `/internal/emit` 汇聚事件。
- 关联：同时本地 socket emit 与 master 汇聚并行。

### [master接收端] [wa-gateway/master.js:505-523] 关键代码片段
```js
app.post('/internal/emit', (req, res) => {
  const ws = resolveWs(req.body?.ws);
  const event = String(req.body?.event || '').trim();
  const payload = req.body?.payload ?? {};
  const workerId = String(req.headers['x-worker-id'] || '') || null;

  if (workerId && event === 'wa:status') {
    const slot = String(payload?.slot || '').trim().toUpperCase();
    if (slot) {
      const rt = ensureWsRuntime(ws);
      if (!rt.statusByWorker.has(workerId)) rt.statusByWorker.set(workerId, new Map());
      rt.statusByWorker.get(workerId).set(slot, String(payload?.status || ''));
    }
  }

  io.to(ws).emit(event, payload);
  return res.json({ ok: true });
});
```
- 作用：master 将 `wa:status` 写入 runtime `statusByWorker`，再转发 socket。
- 关联：`workerActiveCount` 依赖 statusByWorker 决定 MAX_ACTIVE 分配。
- 风险：worker 并未设置 `x-worker-id`，statusByWorker 可能长期为空。

---

## 5) 心跳 / 离线判定 / 自动重连

### [master runtime结构] [wa-gateway/master.js:87-90] 关键代码片段
```js
function ensureWsRuntime(ws) {
  if (!wsRuntime.has(ws)) wsRuntime.set(ws, { lease: null, statusByWorker: new Map(), releaseTimers: new Map() });
  return wsRuntime.get(ws);
}
```
- 作用：master 仅有 lease/statusByWorker/releaseTimers。
- 关联：无 `statusBySlot/lastSeen`。

### [离线/重连处理现状] [wa-gateway/server.js:1816-1854] 关键代码片段
```js
app.post('/api/accounts/:slot/connect', async (req, res) => {
  const force = req.query.force === '1' || req.body?.force === true;
  const st = statuses.get(slot)?.status;
  if (force || st === 'AUTH_FAILURE' || st === 'DISCONNECTED') {
    await destroyClient(ws, slot);
  }
  // ...
  await singleflight(ws, slot, async () => {
    await destroyClient(ws, slot);
    const client = ensureClient(ws, slot);
    await withInitLimit(async () => { await client.initialize(); });
  });
});
```
- 作用：有“手动 connect 时”的重建逻辑。
- 关联：无定时 heartbeat、无超时剔除、无自动重连守护（仅事件回调+手动触发）。

**审计结论（该项）**
- 未发现 worker 定时 heartbeat 上报。
- 未发现 master 基于 `lastSeen` 的超时离线判定。
- 自动重连主要依赖外部调用 `/connect?force=1`，非后台自治。

---

## 6) 在线策略（hot/once）

### [master reconcile + cool-down] [wa-gateway/master.js:455-490] 关键代码片段
```js
async function reconcileWorkspace(ws) {
  const roles = readJson(path.join(wsDir(ws), 'roles.json'), []);
  const accounts = readJson(path.join(wsDir(ws), 'accounts.json'), []);
  const enabledSlots = new Set((accounts || []).filter((a) => a && a.enabled !== false).map((a) => String(a.slot || '').toUpperCase()));
  const hotSlots = new Set((roles || []).map((r) => String(r?.boundSlot || '').toUpperCase()).filter((s) => /^A\d+$/.test(s) && enabledSlots.has(s)));

  for (const slot of hotSlots) {
    if (!lease[slot]) {
      const pick = wsWorkers.find((w) => workerActiveCount(ws, w.id) < MAX_ACTIVE) || wsWorkers[0];
      lease[slot] = pick.id;
      saveLease(ws);
      await requestJsonToWorker(pick, 'POST', `/api/accounts/${slot}/connect?force=1`, { 'x-ws': ws, 'x-connect-mode': 'hot' }, {});
    }
  }

  for (const [slot, wid] of Object.entries(lease)) {
    if (hotSlots.has(slot) || rt.releaseTimers.has(slot)) continue;
    const timer = setTimeout(async () => {
      // ...
      try { await requestJsonToWorker(target, 'POST', `/api/accounts/${slot}/stop`, { 'x-ws': ws }, {}); } catch {}
      releaseLease(ws, slot);
    }, UNBIND_COOLDOWN_MS);
  }
}
```
- 作用：hotSlots 来源是 `roles.boundSlot ∩ enabled accounts`；解绑后延迟 stop。
- 关联：`UNBIND_COOLDOWN_MS` 控制冷却，`MAX_ACTIVE` 控制每 worker 热连接上限。
- 风险：master 调用了 `/api/accounts/:slot/stop`，worker 侧未实现该路由（仅 destroy）。

### [worker warmup] [wa-gateway/server.js:2269-2315] 关键代码片段
```js
async function runWarmup() {
  const roles = loadRoles(ws);
  const accounts = loadAccounts(ws);
  const enabledSlots = new Set(accounts.filter((a) => a?.enabled !== false).map((a) => normalizeSlot(a.slot)).filter(Boolean));
  const rawSlots = Array.from(new Set((roles || []).map((r) => normalizeSlot(r?.boundSlot)).filter(Boolean)));
  const inRangeSlots = rawSlots.filter((slot) => slotInWorkerRange(slot));
  const slots = inRangeSlots.sort((a, b) => slotToNumber(a) - slotToNumber(b));
  const limit = Math.min(capacity, WARMUP_LIMIT, MAX_ACTIVE);
  const selected = slots.slice(0, limit);
  for (const slot of selected) {
    await enqueueSlot(ws, slot, async () => {
      await singleflight(ws, slot, async () => {
        const client = ensureClient(ws, slot);
        await withInitLimit(async () => {
          await client.initialize();
        });
      });
    });
  }
}
```
- 作用：单 worker 模式下按绑定角色进行 warmup。
- 关联：master 模式会跳过 warmup（由 reconcile 接管）。

### [多 worker 分配策略] [wa-gateway/master.js:760-768] 关键代码片段
```js
if (req.method === 'POST' && action === 'connect') {
  target = wsWorkers.find((w) => workerActiveCount(ws, w.id) < MAX_ACTIVE) || null;
  if (!target) return res.status(409).json({ ok: false, error: 'all workers reached max active' });
  lease[slot] = target.id;
  saveLease(ws);
} else {
  const owner = lease[slot];
  target = wsWorkers.find((w) => w.id === owner) || wsWorkers[0];
}
```
- 作用：连接时顺序挑第一个未达上限 worker。
- 关联：>13 后会自动流向 w2/w3（前提 statusByWorker统计准确）。

---

## 7) 角色绑定闭环

### [master 409 保护 + reconcile触发] [wa-gateway/master.js:590-603] 关键代码片段
```js
app.get('/api/roles', (req, res) => {
  const ws = getWsFromReq(req);
  const running = ensureProjectRunning(ws);
  if (!running.ok) return res.status(409).json({ ok: false, error: running.reason });
  return res.json({ ok: true, roles: readJson(path.join(wsDir(ws), 'roles.json'), []) });
});
app.post('/api/roles/batch', async (req, res) => {
  const ws = getWsFromReq(req);
  const running = ensureProjectRunning(ws);
  if (!running.ok) return res.status(409).json({ ok: false, error: running.reason });
  const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
  writeJson(path.join(wsDir(ws), 'roles.json'), roles);
  await reconcileWorkspace(ws);
  return res.json({ ok: true, roles });
});
```
- 作用：roles 读写要求 project=RUNNING；保存后立即触发 reconcile。
- 关联：形成“绑定 -> 热连接/解绑冷却”的主闭环。

### [前端 Roles 保存] [wa-panel-ui/src/pages/TasksPage.tsx:384-391] 关键代码片段
```ts
useEffect(() => {
  if (!rolesLoadedRef.current) return;
  if (rolesSaveTimerRef.current) clearTimeout(rolesSaveTimerRef.current);
  rolesSaveTimerRef.current = setTimeout(() => {
    void http.post("/api/roles/batch", { roles }).catch((e: any) => {
      message.error("保存角色失败：" + (e?.response?.data?.error || e?.message || "unknown error"));
    });
  }, 300);
}, [roles]);
```
- 作用：前端是“全量覆盖 roles”写入（body=`{roles:[...]}`）。
- 关联：触发 master `/api/roles/batch` -> reconcileWorkspace。

---

## 重点风险清单（止血视角）

1. **状态容量统计可能失效**：worker 上报 `/internal/emit` 未附 `x-worker-id`，master `statusByWorker` 可能为空，导致 `workerActiveCount` 失真，进而影响 MAX_ACTIVE 分配与 >13 扩容策略。
2. **stop 路由断链**：master reconcile/前端 once 流程都调用 `/api/accounts/:slot/stop`，但 worker 无该路由，解绑降温与一次性登录回收无法闭环。
3. **心跳缺失**：无 heartbeat/lastSeen，master 无被动离线判定能力，worker 崩溃与静默断链不可观测。
4. **登录状态粒度不足**：未监听 `authenticated/change_state`，UI 与调度对中间态感知不足。
5. **ws 解析不一致**：master 支持 body.ws，worker 不支持；虽可被前端双写掩盖，但存在调用不一致隐患。

---

## 修复优先级列表（可执行路线图）

### P0（立即止血）
1. 补齐 worker -> master 的 `x-worker-id` 上报头；master 记录 `statusByWorker/statusBySlot/lastSeen`。
2. 补齐 worker `/api/accounts/:slot/stop` 语义（建议：destroy client + 发 DISCONNECTED + 资源释放），对齐 master reconcile 与前端 once。
3. 新增 worker heartbeat（如 5s）+ master 超时离线判定（如 15~20s），落地 `lastSeen` 及超时转离线。

### P1（稳定性）
4. 扩展 wwebjs 事件监听：`authenticated`、`change_state`，统一映射到 `wa:status` 机型。
5. 把 `x-connect-mode` 变成后端可见策略（hot 保持驻留、once ready后自动 stop）。
6. 统一 ws 解析契约：worker 同步支持 body.ws，或在接口规范中明令禁止并加校验。

### P2（可运维）
7. 在 `/api/system/recentLogs` 或新 endpoint 暴露 runtime：`statusByWorker/statusBySlot/lastSeen/lease`。
8. 给 roles/batch 加幂等与版本戳（避免 UI 高频全量覆盖竞态）。

---

## 验收清单（curl + UI 现象）

1. **ws 透传一致性**
   - curl：`GET /api/accounts` 分别仅带 `x-ws`、仅带 `?ws=`、同时带两者，返回应同 workspace。
   - UI：从 Master 打开项目窗口后地址含 `#/project?ws=<id>`，页面标题与数据命中该 ws。

2. **roles 绑定触发热连接**
   - curl：`POST /api/roles/batch {roles:[...boundSlot...]}` 后查询 worker/master runtime，目标 slot 被分配 lease 且连接。
   - UI：Tasks 绑定账号后 Accounts 状态从 NEW/DISCONNECTED 向 QR/READY 变化。

3. **解绑冷却 stop**
   - curl：解绑 boundSlot，等待 `UNBIND_COOLDOWN_MS`，确认 slot 被 stop + lease 清理。
   - UI：解绑后状态在冷却窗口结束后转 DISCONNECTED。

4. **once 策略回收**
   - UI：批量“校验并停止未绑定”不再 404；READY 后自动 stop。
   - curl：`POST /api/accounts/:slot/connect?force=1` + mode=once，ready 后自动销毁 client。

5. **心跳离线判定**
   - 操作：杀掉某 worker 进程。
   - 预期：master 在超时阈值后把该 worker/slot 标离线，并在 UI 推送状态变更。

---

## 文字版调用链 / 数据流图

```text
[MasterPage 点击启动项目]
  -> wa-panel-ui/src/pages/MasterPage.tsx openProjectWindow(projectId)
  -> Electron IPC(ws:openProjectWindow)
  -> electron/main.cjs openProjectWindow -> '#/project?ws=<projectId>'
  -> 前端 workspace.ts/getWsId 解析 ws
  -> api.ts 拦截器给每个请求写入 x-ws + ?ws=

[角色绑定保存]
  -> TasksPage useEffect POST /api/roles/batch {roles:[全量]}
  -> master.js /api/roles/batch (要求 project RUNNING)
  -> 写 roles.json
  -> reconcileWorkspace(ws)
      -> 计算 hotSlots = roles.boundSlot ∩ accounts.enabled
      -> 为 hotSlots 分配 lease(slot->worker)
      -> 调 worker /api/accounts/:slot/connect?force=1 (x-connect-mode=hot)
      -> 对解绑 slot 启动 UNBIND_COOLDOWN_MS 定时 stop + releaseLease

[worker 登录链路]
  -> server.js /api/accounts/:slot/connect
  -> ensureAccount(accounts.json: slot/uid/sessionDir)
  -> ensureClient(LocalAuth(clientId=uid,dataPath=workspaceAuthDir)+puppeteer)
  -> client.initialize()
  -> 事件 qr/ready/auth_failure/disconnected
  -> emitWsEvent('wa:status'/'wa:qr')
      -> 本地 io.to(ws).emit
      -> HTTP POST master /internal/emit

[master 状态汇聚]
  -> /internal/emit 收到 wa:status
  -> (若有 x-worker-id) 写 wsRuntime.statusByWorker[workerId][slot]=status
  -> io.to(ws).emit 转发给前端
  -> AccountsPage/TasksPage socket.on('wa:status') 更新 UI

[当前缺口]
  - 无 heartbeat/lastSeen 超时判定
  - stop 路由在 master->worker 断链
  - worker-id 头缺失导致容量统计可能失真
```
