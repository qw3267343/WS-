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
const MAX_ACTIVE = process.env.MAX_ACTIVE;
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
};
  if (MASTER_TOKEN) env.MASTER_TOKEN = MASTER_TOKEN;
  if (MAX_ACTIVE) env.MAX_ACTIVE = String(MAX_ACTIVE);
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
  if (!event) return res.status(400).json({ ok: false, error: 'event required' });
  io.to(ws).emit(event, req.body?.payload ?? {});
  log('info', 'worker_event_forwarded', { ws, event });
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



app.use('/api', async (req, res) => {
  try {
    const slot = parseSlot(req);

    // ✅ 有 slot：按段路由；没 slot：默认走 worker1（shards[0]）
    const shard = slot ? shardForSlot(slot) : shards[0];
    if (!shard) return res.status(404).json({ ok: false, error: 'no shard available' });

    if (!slot) {
      log('warn', 'no_slot_default_route', { method: req.method, url: req.originalUrl, to: shard.id || shard.port });
    }

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
});
