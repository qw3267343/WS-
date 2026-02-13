const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT_MASTER = Number(process.env.PORT_MASTER || 3000);
const CONFIG_ROOT = path.resolve(process.env.CONFIGDIR || path.join(__dirname, 'data_runtime', 'data'));
const PREWARM = Math.max(0, Number(process.env.PREWARM || 2));
const MASTER_TOKEN = String(process.env.MASTER_TOKEN || '').trim();
const MAX_ACTIVE = process.env.MAX_ACTIVE;
const MAX_INIT = process.env.MAX_INIT || process.env.WA_INIT_CONCURRENCY;
const WARMUP_LIMIT = process.env.WARMUP_LIMIT;
const LOG_LEVEL = process.env.LOG_LEVEL;

function parseShards() {
  if (process.env.SHARDS_JSON) return JSON.parse(process.env.SHARDS_JSON);
  return [
    { id: 'w1', port: 3001, from: 'A1', to: 'A50', workdir: './data_w1' },
    { id: 'w2', port: 3002, from: 'A51', to: 'A100', workdir: './data_w2' },
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
function slotToNumber(slot) {
  const m = /^A(\d+)$/i.exec(String(slot || '').trim());
  return m ? Number(m[1]) : null;
}
function shardForSlot(slot) {
  const n = slotToNumber(slot);
  if (!Number.isFinite(n)) return null;
  return shards.find((s) => {
    const from = slotToNumber(s.from);
    const to = slotToNumber(s.to);
    return (!Number.isFinite(from) || n >= from) && (!Number.isFinite(to) || n <= to);
  }) || null;
}
function parseSlot(req) {
  const m = /^\/api\/accounts\/([^/]+)/.exec(req.path);
  if (m) return String(m[1]).toUpperCase();
  const body = req.body || {};
  return String(body.slot || body.boundSlot || body?.role?.boundSlot || '').trim().toUpperCase() || null;
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

  const env = {
    ...process.env,
    PORT: String(shard.port),
    CONFIGDIR: CONFIG_ROOT,
    WORKDIR: path.resolve(shard.workdir || `./data_${shard.id}`),
    SLOT_FROM: String(shard.from),
    SLOT_TO: String(shard.to),
    MASTER_INTERNAL_URL: `http://127.0.0.1:${PORT_MASTER}`,
  };
  if (MASTER_TOKEN) env.MASTER_TOKEN = MASTER_TOKEN;
  if (MAX_ACTIVE) env.MAX_ACTIVE = String(MAX_ACTIVE);
  if (MAX_INIT) env.MAX_INIT = String(MAX_INIT);
  if (WARMUP_LIMIT) env.WARMUP_LIMIT = String(WARMUP_LIMIT);
  if (LOG_LEVEL) env.LOG_LEVEL = String(LOG_LEVEL);

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

app.get('/api/accounts', (req, res, next) => {
  const ws = resolveWs(req.query?.ws || req.headers['x-ws'] || 'default');
  const file = path.join(CONFIG_ROOT, 'workspaces', ws, 'accounts.json');
  if (!fs.existsSync(file)) return next();
  return res.json({ ok: true, data: readJson(file, []) });
});
app.get('/api/roles', (req, res, next) => {
  const ws = resolveWs(req.query?.ws || req.headers['x-ws'] || 'default');
  const file = path.join(CONFIG_ROOT, 'workspaces', ws, 'roles.json');
  if (!fs.existsSync(file)) return next();
  return res.json({ ok: true, roles: readJson(file, []) });
});
app.get('/api/groups', (req, res, next) => {
  const ws = resolveWs(req.query?.ws || req.headers['x-ws'] || 'default');
  const file = path.join(CONFIG_ROOT, 'workspaces', ws, 'groups.json');
  if (!fs.existsSync(file)) return next();
  return res.json({ ok: true, rows: readJson(file, []) });
});

app.use('/api', async (req, res) => {
  try {
    const slot = parseSlot(req);
    let shard = slot ? shardForSlot(slot) : shards[0];
    if (!shard) return res.status(400).json({ ok: false, error: 'slot required for routing' });
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
