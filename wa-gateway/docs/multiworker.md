# 多 worker / master 模式说明

## Worker 模式（`server.js`）

### 关键环境变量

- `SLOT_FROM` / `SLOT_TO`：当前 worker 负责的 slot 区间（例如 `A1`~`A50`）。
- `MAX_ACTIVE`：当前 worker 最大活跃 client 数（`clients Map` 中存在即计入，含 INIT/QR/READY）。
- `MAX_INIT`：初始化并发上限。
- `WARMUP_LIMIT`：启动 warmup 的最大尝试数，默认 `10`。
- `CONFIGDIR`：共享配置目录（账号/角色/群组/历史等 JSON）。
- `WORKDIR`：worker 运行态目录（LocalAuth/session/uploads 等）。
- `MASTER_INTERNAL_URL` / `MASTER_TOKEN`：master 事件汇聚内部上报地址与鉴权。

### 行为说明

- 任何操作 slot 的入口（connect/open/openChat/logout/destroy/status/send/schedule）会先校验是否在 `SLOT_FROM~SLOT_TO`。
  - 不在本段返回：`409 { ok:false, error:"slot not in this worker" }`。
- 容量保护：
  - connect / rebuild 等会触发 client 初始化的路径统一受 `MAX_ACTIVE` 限制。
  - 超限返回 `429 { ok:false, error:"worker capacity full" }`。
  - recentLogs 记录：`worker_capacity_full`。
- `/health` 返回：
  - `{ ok:true, worker:{ port, slotFrom, slotTo, active, maxActive } }`。

### 启动 warmup

worker `listen` 成功后异步启动 warmup：

1. 读取 `roles.json` 的 `boundSlot`。
2. 仅保留落在本 worker 区间的 slot。
3. 与 `accounts.json` 中 `enabled=true` 交集。
4. 取 `min(MAX_ACTIVE-当前active, WARMUP_LIMIT, MAX_ACTIVE)` 个，按 slot 数字升序。
5. 复用 connect/ensureClient 初始化链路，低速串行预热。

日志事件：

- `warmup_start {ws,count,slots}`
- `warmup_done {ws,ok,fail}`
- `warmup_skip_disabled {ws,slot}`
- `warmup_capacity_full {ws,active,maxActive}`

## Master 模式（`master.js`）

### 关键环境变量

- `PORT_MASTER`：master 对前端暴露端口，默认 `3000`。
- `PREWARM`：master 启动时预热 worker 数量，默认 `2`。
- `SHARDS_JSON`：worker 分片定义数组，例如：

```json
[
  {"id":"w1","port":3001,"from":"A1","to":"A50","workdir":"./data_w1"},
  {"id":"w2","port":3002,"from":"A51","to":"A100","workdir":"./data_w2"}
]
```

### 行为说明

- master 接收全部 `/api/*` 请求并按 slot 路由：
  - URL: `/api/accounts/:slot/...`
  - body: `slot / boundSlot / role.boundSlot`
- 若目标 worker 未启动：`ensureWorkerRunning` 懒启动 + 轮询 `/health`。
- 未携带 slot：
  - `GET /api/accounts`、`GET /api/roles`、`GET /api/groups` 由 master 直接读取 `CONFIGDIR`。
  - 其他默认转发到首个 shard。
- master `/health`：
  - `{ ok:true, master:{port}, workers:[{id,port,from,to,running}] }`

## 实时事件汇聚（前端只连 master）

- master 提供 `POST /internal/emit`（可选 `x-master-token` 鉴权）。
- worker 在本地 `wa:status`/`wa:qr` emit 的同时，向 master `/internal/emit` 上报。
- master 收到后转发到 `io.to(ws).emit(event,payload)`。
- recentLogs 记录：`worker_event_forwarded`；worker 上报失败记录 `master_emit_failed`（不影响主流程）。

## 启动示例

### 2 worker + master（懒启动 + PREWARM=2）

```bash
# worker（可手动）
PORT=3001 SLOT_FROM=A1 SLOT_TO=A50 MAX_ACTIVE=20 MAX_INIT=2 WARMUP_LIMIT=10 CONFIGDIR=./data_shared WORKDIR=./data_w1 node server.js
PORT=3002 SLOT_FROM=A51 SLOT_TO=A100 MAX_ACTIVE=20 MAX_INIT=2 WARMUP_LIMIT=10 CONFIGDIR=./data_shared WORKDIR=./data_w2 node server.js

# master（推荐前端只连接此端口）
PORT_MASTER=3000 PREWARM=2 CONFIGDIR=./data_shared \
SHARDS_JSON='[{"id":"w1","port":3001,"from":"A1","to":"A50","workdir":"./data_w1"},{"id":"w2","port":3002,"from":"A51","to":"A100","workdir":"./data_w2"}]' \
node master.js
```

### 7 worker 示例

按区间扩展 shard：`A1-50`、`A51-100` ... `A301-350`，每个 worker 使用独立 `WORKDIR`，共享同一个 `CONFIGDIR`。
