const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ----- 默认目录工具（AppData）-----
function getDefaultRoot() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, '@ws-manager', 'wa-gateway-data');
}
const DEFAULT_ROOT = getDefaultRoot();
const DATA_ROOT = path.resolve(process.env.DATA_DIR || DEFAULT_ROOT);
const DEFAULT_CONFIG_ROOT = path.join(DATA_ROOT, 'data');
const DEFAULT_WORK_BASE = path.join(DATA_ROOT, 'work');

// ----- 环境变量 -----
const PORT_MASTER = Number(process.env.PORT_MASTER || 3000);
// ✅ CONFIG_ROOT：优先 CONFIGDIR，其次 DATA_DIR/data，最后 AppData 默认
const CONFIG_ROOT = path.resolve(
  process.env.CONFIGDIR ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data') : DEFAULT_CONFIG_ROOT)
);
const PREWARM = Math.max(0, Number(process.env.PREWARM || 2));
const MASTER_TOKEN = String(process.env.MASTER_TOKEN || '').trim();
const MAX_ACTIVE_ENV = process.env.MAX_ACTIVE;
const MAX_ACTIVE = Math.max(1, Number(process.env.MAX_ACTIVE || 13));
const POOL_SIZE = Math.max(1, Number(process.env.POOL_SIZE || 3));
const UNBIND_COOLDOWN_MS = Math.max(0, Number(process.env.UNBIND_COOLDOWN_MS || 120000));
const MAX_INIT = process.env.MAX_INIT || process.env.WA_INIT_CONCURRENCY;
const WARMUP_LIMIT = process.env.WARMUP_LIMIT;
const LOG_LEVEL = process.env.LOG_LEVEL;

// ----- 分片定义 -----
function parseShards() {
  if (process.env.SHARDS_JSON) return JSON.parse(process.env.SHARDS_JSON);
  // 默认分片：使用 AppData 下的 work 目录
  return [
    { id: 1, port: 3001, from: 'A1',  to: 'A30',  workdir: path.join(DEFAULT_WORK_BASE, 'w1') },
    { id: 2, port: 3002, from: 'A31', to: 'A60',  workdir: path.join(DEFAULT_WORK_BASE, 'w2') },
  ];
}
const shards = parseShards();
const workers = new Map();
const RECENT_LOGS = [];
const wsRuntime = new Map(); // ws -> { pool, lease, lastWorker, statusByWorker, releaseTimers }

function log(level, event, fields = {}) {
  const row = { ts: new Date().toISOString(), level, event, ...fields };
  RECENT_LOGS.push(row);
  if (RECENT_LOGS.length > 200) RECENT_LOGS.splice(0, RECENT_LOGS.length - 200);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

function resolveWs(raw) {
  const s = String(raw || 'default').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'default';
}
function slotToNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;

  const s = String(v).trim().toUpperCase();
  // 支持 A123
  let m = /^A(\d+)$/.exec(s);
  if (m) return Number(m[1]);
  // 支持 123
  m = /^(\d+)$/.exec(s);
  if (m) return Number(m[1]);

  return null;
}
function shardForSlot(slot) {
  const n = slotToNumber(slot);
  if (!Number.isFinite(n)) return null;

  return (
    shards.find((s) => {
      const from = slotToNumber(s.from);
      const to = slotToNumber(s.to);
      if (Number.isFinite(from) && n < from) return false;
      if (Number.isFinite(to) && n > to) return false;
      return true;
    }) || null
  );
}
function parseSlot(req) {
  const fullPath = `${req.baseUrl || ''}${req.path || ''}`;
  let m = /\/accounts\/(A\d+)(\/|$)/i.exec(fullPath);
  if (m) return String(m[1]).toUpperCase();

  const ou = String(req.originalUrl || req.url || '');
  m = /\/accounts\/(A\d+)(\/|$)/i.exec(ou);
  if (m) return String(m[1]).toUpperCase();

  const body = req.body || {};

  // ✅ 兼容 roles/batch：body.roles 是数组，里面的 role 可能有 boundSlot
  if (Array.isArray(body.roles)) {
    const r = body.roles.find(x => x && typeof x === 'object' && x.boundSlot);
    if (r?.boundSlot) {
      const s = String(r.boundSlot).trim().toUpperCase();
      if (/^A\d+$/.test(s)) return s;
    }
  }

  const cand = body.slot || body.boundSlot || body?.role?.boundSlot || '';
  const s = String(cand).trim().toUpperCase();
  return /^A\d+$/.test(s) ? s : null;
}


function readJson(file, fallback) {
  try {
    const txt = fs.readFileSync(file, 'utf-8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function wsDir(ws) {
  return path.join(CONFIG_ROOT, 'workspaces', ws);
}
function wsPoolFile(ws) {
  return path.join(wsDir(ws), 'pool.json');
}
function wsLeaseFile(ws) {
  return path.join(wsDir(ws), 'slot_owner.json');
}
function ensureWsRuntime(ws) {
  if (!wsRuntime.has(ws)) {
    wsRuntime.set(ws, {
      pool: null,
      lease: null,
      lastWorker: new Map(),
      statusByWorker: new Map(),
      releaseTimers: new Map(),
    });
  }
  return wsRuntime.get(ws);
}
function writeJson(file, val) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(val, null, 2), 'utf-8');
}
function loadPool(ws) {
  const rt = ensureWsRuntime(ws);
  if (Array.isArray(rt.pool) && rt.pool.length) return rt.pool;
  const file = wsPoolFile(ws);
  const fromFile = readJson(file, null);
  if (Array.isArray(fromFile) && fromFile.length) {
    rt.pool = fromFile.map(Number).filter((id) => shards.some((x) => x.id === id));
  }
  if (!rt.pool || !rt.pool.length) {
    rt.pool = shards.map((s) => s.id).slice(0, Math.min(POOL_SIZE, shards.length));
    writeJson(file, rt.pool);
  }
  return rt.pool;
}
function loadLease(ws) {
  const rt = ensureWsRuntime(ws);
  if (rt.lease && typeof rt.lease === 'object') return rt.lease;
  const fromFile = readJson(wsLeaseFile(ws), {});
  rt.lease = (fromFile && typeof fromFile === 'object') ? fromFile : {};
  return rt.lease;
}
function saveLease(ws) {
  const lease = loadLease(ws);
  writeJson(wsLeaseFile(ws), lease);
}
function isActiveStatus(status) {
  return ['INIT', 'QR', 'READY', 'AUTH_FAILURE'].includes(String(status || ''));
}
function workerActiveCount(ws, workerId) {
  const rt = ensureWsRuntime(ws);
  const map = rt.statusByWorker.get(Number(workerId)) || new Map();
  let n = 0;
  for (const st of map.values()) if (isActiveStatus(st)) n++;
  return n;
}

function globalWorkerActiveCount(workerId) {
  let n = 0;
  for (const rt of wsRuntime.values()) {
    const map = rt.statusByWorker.get(Number(workerId)) || new Map();
    for (const st of map.values()) if (isActiveStatus(st)) n++;
  }
  return n;
}

function setLeaseWorker(ws, slot, workerId) {
  const lease = loadLease(ws);
  const prev = lease[slot];
  if (Number(prev) === Number(workerId)) return;
  lease[slot] = Number(workerId);
  saveLease(ws);
  log('info', 'lease_assign', { ws, slot, workerId: Number(workerId) });
}
function ensurePool(ws) {
  const pool = loadPool(ws);
  if (!pool.length) throw new Error('pool empty');
  return pool;
}
function pickWorkerForHot(ws) {
  const pool = ensurePool(ws);
  for (const id of pool) {
    if (workerActiveCount(ws, id) < MAX_ACTIVE) return id;
  }
  return null;
}
function pickWorkerForOnce(ws) {
  return pickWorkerForHot(ws);
}
function assignLease(ws, slot) {
  const lease = loadLease(ws);
  if (lease[slot]) return Number(lease[slot]);
  const wid = pickWorkerForHot(ws);
  if (!wid) return null;
  lease[slot] = wid;
  saveLease(ws);
  log('info', 'lease_assign', { ws, slot, workerId: wid });
  return wid;
}
function releaseLease(ws, slot) {
  const lease = loadLease(ws);
  const workerId = lease[slot];
  if (!workerId) return;
  delete lease[slot];
  saveLease(ws);
  log('info', 'lease_release', { ws, slot, workerId });
}
function parseAccountAction(req) {
  const m = /\/accounts\/A\d+\/([^/?#]+)/i.exec(String(req.originalUrl || req.url || ''));
  return m ? String(m[1]).toLowerCase() : '';
}
function getWsFromReq(req) {
  return resolveWs(req.query?.ws || req.headers['x-ws'] || req.body?.ws || 'default');
}
function lastWorkerFor(ws, slot) {
  const rt = ensureWsRuntime(ws);
  return Number(rt.lastWorker.get(slot) || 0) || null;
}
function shardById(id) {
  return shards.find((s) => s.id === Number(id)) || null;
}


async function waitWorkerHealth(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${port}/health`, (res) => resolve(res.statusCode === 200)).on('error', () => resolve(false));
      });
      if (ok) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`worker ${port} health timeout`);
}

async function ensureWorkerRunning(shard) {
  const running = workers.get(shard.id);
  if (running && running.state === 'running') return running;
  if (running && running.startingPromise) {
    await running.startingPromise;
    return workers.get(shard.id);
  }

const fromN = slotToNumber(shard.from);
const toN   = slotToNumber(shard.to);

const env = {
  ...process.env,
  PORT: String(shard.port),
  DATA_DIR: DATA_ROOT,
  CONFIGDIR: CONFIG_ROOT,
  // WORKDIR：优先 shard.workdir，否则使用 AppData 下的默认 work 目录
  WORKDIR: path.resolve(shard.workdir || path.join(DEFAULT_WORK_BASE, `w${shard.id}`)),
  SLOT_FROM: fromN == null ? '' : String(fromN),
  SLOT_TO:   toN == null ? '' : String(toN),
  MASTER_INTERNAL_URL: `http://127.0.0.1:${PORT_MASTER}`,
  WORKER_ID: String(shard.id),
};
  if (MASTER_TOKEN) env.MASTER_TOKEN = MASTER_TOKEN;
  if (MAX_ACTIVE_ENV) env.MAX_ACTIVE = String(MAX_ACTIVE);
  else env.MAX_ACTIVE = String(MAX_ACTIVE);
  if (MAX_INIT) env.MAX_INIT = String(MAX_INIT);
  if (WARMUP_LIMIT) env.WARMUP_LIMIT = String(WARMUP_LIMIT);
  if (LOG_LEVEL) env.LOG_LEVEL = String(LOG_LEVEL);

  log('info', 'spawn_worker_env', {
    id: shard.id,
    port: shard.port,
    CONFIGDIR: env.CONFIGDIR,
    WORKDIR: env.WORKDIR,
    DATA_ROOT,
  });

  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: 'inherit' });
  const entry = { child, state: 'starting' };
  workers.set(shard.id, entry);
  child.on('exit', (code) => {
    log('warn', 'worker_exit', { id: shard.id, code });
    workers.set(shard.id, { state: 'stopped' });
  });

  const startingPromise = waitWorkerHealth(shard.port)
    .then(() => {
      workers.set(shard.id, { child, state: 'running' });
      log('info', 'worker_ready', { id: shard.id, port: shard.port, from: shard.from, to: shard.to });
    })
    .catch((e) => {
      workers.set(shard.id, { state: 'failed' });
      log('error', 'worker_start_failed', { id: shard.id, err: String(e?.message || e) });
      throw e;
    });

  workers.set(shard.id, { child, state: 'starting', startingPromise });
  await startingPromise;
  return workers.get(shard.id);
}

function proxyToShard(req, res, shard) {
  return new Promise((resolve) => {
    const headers = { ...req.headers, host: `127.0.0.1:${shard.port}` };
    const options = { hostname: '127.0.0.1', port: shard.port, path: req.originalUrl, method: req.method, headers };
    const upstream = http.request(options, (upRes) => {
      res.statusCode = upRes.statusCode || 502;
      for (const [k, v] of Object.entries(upRes.headers || {})) {
        if (v !== undefined) res.setHeader(k, v);
      }
      upRes.pipe(res);
      upRes.on('end', resolve);
    });
    upstream.on('error', (e) => {
      res.status(502).json({ ok: false, error: String(e?.message || e) });
      resolve();
    });

    if (req.body && Object.keys(req.body).length > 0 && req.is('application/json')) {
      upstream.write(JSON.stringify(req.body));
      upstream.end();
      return;
    }
    req.pipe(upstream);
  });
}


async function requestJsonToShard(shard, method, urlPath, headers = {}, body = null) {
  await ensureWorkerRunning(shard);
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf-8');
    const req = http.request({
      hostname: '127.0.0.1',
      port: shard.port,
      path: urlPath,
      method,
      headers: {
        'content-type': 'application/json',
        ...(payload ? { 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode || 0, json, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  const raw = socket.handshake.query?.ws || socket.handshake.headers?.['x-ws'] || 'default';
  socket.join(resolveWs(Array.isArray(raw) ? raw[0] : raw));
});

app.post('/internal/emit', (req, res) => {
  if (MASTER_TOKEN && req.headers['x-master-token'] !== MASTER_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const ws = resolveWs(req.body?.ws);
  const event = String(req.body?.event || '').trim();
  const payload = req.body?.payload ?? {};
  const workerId = Number(req.headers['x-worker-id'] || 0) || null;
  if (!event) return res.status(400).json({ ok: false, error: 'event required' });

  if (workerId && event === 'wa:status') {
    const slot = String(payload?.slot || '').trim().toUpperCase();
    if (slot) {
      const rt = ensureWsRuntime(ws);
      rt.lastWorker.set(slot, workerId);
      if (!rt.statusByWorker.has(workerId)) rt.statusByWorker.set(workerId, new Map());
      rt.statusByWorker.get(workerId).set(slot, String(payload?.status || ''));
    }
  }

  io.to(ws).emit(event, payload);
  log('info', 'worker_event_forwarded', { ws, event, workerId: workerId || undefined });
  return res.json({ ok: true });
});

app.get('/api/system/recentLogs', (_req, res) => res.json({ ok: true, logs: RECENT_LOGS }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    master: { port: PORT_MASTER },
    workers: shards.map((s) => ({ id: s.id, port: s.port, from: s.from, to: s.to, running: workers.get(s.id)?.state === 'running' })),
  });
});

app.get('/api/accounts', (req, res) => {
  const ws = resolveWs(req.query?.ws || req.headers['x-ws'] || 'default');
  const file = path.join(CONFIG_ROOT, 'workspaces', ws, 'accounts.json');
  const data = fs.existsSync(file) ? readJson(file, []) : [];
  return res.json({ ok: true, data });
});

app.get('/api/roles', (req, res) => {
  const ws = resolveWs(req.query?.ws || req.headers['x-ws'] || 'default');
  const file = path.join(CONFIG_ROOT, 'workspaces', ws, 'roles.json');
  const roles = fs.existsSync(file) ? readJson(file, []) : [];
  return res.json({ ok: true, roles });
});

app.get('/api/groups', (req, res) => {
  const ws = resolveWs(req.query?.ws || req.headers['x-ws'] || 'default');
  const file = path.join(CONFIG_ROOT, 'workspaces', ws, 'groups.json');
  const rows = fs.existsSync(file) ? readJson(file, []) : [];
  return res.json({ ok: true, rows });
});


async function reconcileWorkspace(ws) {
  const rws = resolveWs(ws);
  log('info', 'reconcile_start', { ws: rws });
  const dir = wsDir(rws);
  const roles = readJson(path.join(dir, 'roles.json'), []);
  const accounts = readJson(path.join(dir, 'accounts.json'), []);
  const enabledSlots = new Set((accounts || []).filter((a) => a && a.enabled !== false).map((a) => String(a.slot || '').toUpperCase()));
  const hotSlots = new Set((roles || []).map((r) => String(r?.boundSlot || '').toUpperCase()).filter((slot) => /^A\d+$/.test(slot) && enabledSlots.has(slot)));

  const rt = ensureWsRuntime(rws);
  const lease = loadLease(rws);

  for (const slot of hotSlots) {
    const t = rt.releaseTimers.get(slot);
    if (t) {
      clearTimeout(t);
      rt.releaseTimers.delete(slot);
    }
    if (!lease[slot]) {
      const wid = assignLease(rws, slot);
      if (wid) {
        const shard = shardById(wid);
        if (shard) {
          try {
            await requestJsonToShard(shard, 'POST', `/api/accounts/${slot}/connect?force=1`, { 'x-ws': rws, 'x-connect-mode': 'hot' }, {});
          } catch (e) {
            log('warn', 'reconcile_connect_fail', { ws: rws, slot, err: String(e?.message || e) });
          }
        }
      }
    }
  }

  for (const [slot, wid] of Object.entries(lease)) {
    if (hotSlots.has(slot)) continue;
    if (rt.releaseTimers.has(slot)) continue;
    const timer = setTimeout(async () => {
      rt.releaseTimers.delete(slot);
      const shard = shardById(wid);
      if (shard) {
        try {
          await requestJsonToShard(shard, 'POST', `/api/accounts/${slot}/stop`, { 'x-ws': rws }, {});
        } catch (e) {
          log('warn', 'reconcile_stop_fail', { ws: rws, slot, err: String(e?.message || e) });
        }
      }
      releaseLease(rws, slot);
    }, UNBIND_COOLDOWN_MS);
    rt.releaseTimers.set(slot, timer);
  }

  log('info', 'reconcile_done', { ws: rws, hotCount: hotSlots.size });
}

app.post('/api/roles/batch', async (req, res) => {
  try {
    const ws = getWsFromReq(req);
    const shard = shards[0];
    if (!shard) return res.status(404).json({ ok: false, error: 'no shard available' });
    const r = await requestJsonToShard(shard, 'POST', req.originalUrl, req.headers || {}, req.body || {});
    if (r.status >= 200 && r.status < 300 && r.json?.ok) {
      await reconcileWorkspace(ws);
    }
    return res.status(r.status || 502).json(r.json || { ok: false, error: r.text || 'upstream failed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== Projects (workspaces) CRUD on master =====================
function safeProjectId(raw) {
  // 前端 ws 可能是 "6688" / "p_100001" 这种；允许字母数字_-，其它替换成 _
  const s = String(raw || '').trim();
  if (!s) return null;
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

function projectDir(id) {
  return path.join(CONFIG_ROOT, 'workspaces', id);
}

function projectMetaFile(id) {
  return path.join(projectDir(id), 'project.json');
}

function loadProjectMeta(id) {
  const file = projectMetaFile(id);
  if (fs.existsSync(file)) {
    const obj = readJson(file, null);
    if (obj && typeof obj === 'object') return obj;
  }
  // 兼容旧结构：没有 project.json 也算一个项目
  return { id, name: id, createdAt: null, updatedAt: null };
}

function saveProjectMeta(id, meta) {
  const dir = projectDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = projectMetaFile(id);
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), 'utf-8');
}

// GET /api/projects  (注意：前端会带 ?ws=xxx，这里忽略)
app.get('/api/projects', (_req, res) => {
  try {
    const dir = path.join(CONFIG_ROOT, 'workspaces');
    if (!fs.existsSync(dir)) {
      return res.json({ ok: true, data: [], rows: [], projects: [] });
    }
    const ids = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));

    const rows = ids.map(id => {
      const meta = loadProjectMeta(id);
      return { id, name: meta?.name || id, createdAt: meta?.createdAt || null, updatedAt: meta?.updatedAt || null };
    });

    // 多字段兼容（前端用 data/rows/projects 任意一个都能接上）
    return res.json({ ok: true, data: rows, rows, projects: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/projects/:id
app.get('/api/projects/:id', (req, res) => {
  try {
    const id = safeProjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const dir = projectDir(id);
    if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'project not found' });

    const meta = loadProjectMeta(id);
    return res.json({ ok: true, data: { id, ...(meta || {}) } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/projects  body: {id,name}（允许只传 name，则用 name 生成 id）
app.post('/api/projects', (req, res) => {
  try {
    const body = req.body || {};
    const id = safeProjectId(body.id || body.ws || body.projectId || body.name);
    const name = String(body.name || body.title || id || '').trim();

    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const dir = projectDir(id);
    if (fs.existsSync(dir)) return res.status(409).json({ ok: false, error: 'project already exists' });

    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    saveProjectMeta(id, { id, name: name || id, createdAt: now, updatedAt: now });

    return res.json({ ok: true, data: { id, name: name || id } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// PUT /api/projects/:id  body: {name}
app.put('/api/projects/:id', (req, res) => {
  try {
    const id = safeProjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const dir = projectDir(id);
    if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'project not found' });

    const body = req.body || {};
    const meta = loadProjectMeta(id);
    const now = Date.now();

    const name = String(body.name || body.title || meta?.name || id).trim();
    const next = { ...(meta || {}), id, name, updatedAt: now, createdAt: meta?.createdAt || now };

    saveProjectMeta(id, next);
    return res.json({ ok: true, data: next });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// DELETE /api/projects/:id
app.delete('/api/projects/:id', (req, res) => {
  try {
    const id = safeProjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const dir = projectDir(id);
    if (!fs.existsSync(dir)) return res.json({ ok: true });

    // ⚠️ 删除整个 workspace（包含 accounts/roles/groups 等）
    fs.rmSync(dir, { recursive: true, force: true });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
// ===================== end projects =====================




async function reconcileWarmup() {
  try {
    const base = path.join(CONFIG_ROOT, 'workspaces');
    if (!fs.existsSync(base)) {
      log('info', 'master_warmup_start', { workspaces: 0, totalSlots: 0 });
      log('info', 'master_warmup_done', { ok: 0, fail: 0 });
      return;
    }

    const wsList = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const tasks = [];
    for (const wsName of wsList) {
      const ws = resolveWs(wsName);
      const roles = readJson(path.join(base, wsName, 'roles.json'), []);
      const accounts = readJson(path.join(base, wsName, 'accounts.json'), []);
      const enabled = new Set((accounts || []).filter((a) => a && a.enabled !== false).map((a) => String(a.slot || '').trim().toUpperCase()));
      const hotSlots = Array.from(new Set((roles || []).map((r) => String(r?.boundSlot || '').trim().toUpperCase())))
        .filter((slot) => /^A\d+$/.test(slot) && enabled.has(slot));

      for (const slot of hotSlots) {
        const shard = shardForSlot(slot);
        if (!shard) continue;
        tasks.push({ ws, slot, workerId: shard.id, shard });
      }
    }

    log('info', 'master_warmup_start', { workspaces: wsList.length, totalSlots: tasks.length });

    const planned = new Map();
    for (const shard of shards) planned.set(shard.id, globalWorkerActiveCount(shard.id));

    let ok = 0;
    let fail = 0;
    for (const t of tasks) {
      const current = Number(planned.get(t.workerId) || 0);
      if (current >= MAX_ACTIVE) {
        log('warn', 'warmup_capacity_full', { workerId: t.workerId, ws: t.ws, slot: t.slot });
        fail += 1;
        continue;
      }

      try {
        setLeaseWorker(t.ws, t.slot, t.workerId);
        const r = await requestJsonToShard(t.shard, 'POST', `/api/accounts/${t.slot}/connect?force=1`, { 'x-ws': t.ws, 'x-connect-mode': 'hot' }, {});
        if (r.status >= 200 && r.status < 300 && r.json?.ok) {
          ok += 1;
          planned.set(t.workerId, current + 1);
        } else {
          fail += 1;
        }
      } catch {
        fail += 1;
      }
    }

    log('info', 'master_warmup_done', { ok, fail });
  } catch (e) {
    log('warn', 'master_warmup_failed', { err: String(e?.message || e) });
  }
}

app.use('/api', async (req, res) => {
  try {
    const ws = getWsFromReq(req);
    const slot = parseSlot(req);
    let shard = null;

    if (slot) {
      const lease = loadLease(ws);
      const action = parseAccountAction(req);
      const connectMode = String(req.headers['x-connect-mode'] || '').trim().toLowerCase();
      const isConnect = req.method === 'POST' && action === 'connect';

      if (isConnect && connectMode === 'hot') {
        const ownerShard = shardForSlot(slot);
        const preferredWorkerId = ownerShard?.id || null;
        const leasedWorkerId = Number(lease[slot] || 0) || null;
        const wid = leasedWorkerId || preferredWorkerId || assignLease(ws, slot);
        if (wid) {
          if (!leasedWorkerId) setLeaseWorker(ws, slot, wid);
          shard = shardById(wid);
        }
      } else if (isConnect && connectMode === 'once') {
        const wid = pickWorkerForOnce(ws);
        shard = shardById(wid);
      } else {
        const wid = Number(lease[slot] || 0) || lastWorkerFor(ws, slot) || shards[0]?.id;
        shard = shardById(wid);
      }

      if (!shard) {
        shard = shardForSlot(slot) || shards[0];
      }
    } else {
      shard = shards[0];
      log('warn', 'no_slot_default_route', { method: req.method, url: req.originalUrl, to: shard?.id || shard?.port });
    }

    if (!shard) return res.status(404).json({ ok: false, error: 'no shard available' });

    await ensureWorkerRunning(shard);
    await proxyToShard(req, res, shard);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


server.listen(PORT_MASTER, async () => {
  log('info', 'master_listen', { port: PORT_MASTER });
  for (const shard of shards.slice(0, PREWARM)) {
    try { await ensureWorkerRunning(shard); } catch {}
  }
  await reconcileWarmup();
});
