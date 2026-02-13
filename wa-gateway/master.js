const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function getDefaultRoot() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, '@ws-manager', 'wa-gateway-data');
}
const DEFAULT_ROOT = getDefaultRoot();
const DATA_ROOT = path.resolve(process.env.DATA_DIR || DEFAULT_ROOT);
const CONFIG_ROOT = path.resolve(process.env.CONFIGDIR || path.join(DATA_ROOT, 'data'));
const WORK_ROOT = path.resolve(process.env.WORKDIR || path.join(DATA_ROOT, 'work'));
const PORT_MASTER = Number(process.env.PORT_MASTER || 3000);
const MASTER_TOKEN = String(process.env.MASTER_TOKEN || '').trim();
const WORKER_POOL_SIZE = Math.max(3, Number(process.env.WORKER_POOL_SIZE || 60));
const WORKER_PORT_BASE = Math.max(1, Number(process.env.WORKER_PORT_BASE || 3101));
const WORKERS_PER_PROJECT = 3;
const MAX_ACTIVE = 13;
const UNBIND_COOLDOWN_MS = Math.max(0, Number(process.env.UNBIND_COOLDOWN_MS || 120000));
const PROJECTS_FILE = path.join(CONFIG_ROOT, 'projects.json');
const PROJECT_COUNTER_FILE = path.join(CONFIG_ROOT, 'project_counter.txt');

const RECENT_LOGS = [];
const workers = new Map(); // workerId -> {child,state,startingPromise,ws}
const wsRuntime = new Map();

function log(level, event, fields = {}) {
  const row = { ts: new Date().toISOString(), level, event, ...fields };
  RECENT_LOGS.push(row);
  if (RECENT_LOGS.length > 200) RECENT_LOGS.splice(0, RECENT_LOGS.length - 200);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; } }
function writeJson(file, data) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8'); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withFileLockSync(lockFile, fn, timeoutMs = 15000, pollMs = 40) {
  const start = Date.now();
  while (true) {
    let fd = null;
    try {
      ensureDir(path.dirname(lockFile));
      fd = fs.openSync(lockFile, 'wx');
      return fn();
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) throw new Error(`lock timeout: ${lockFile}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
    } finally {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
    }
  }
}

function resolveWs(raw) {
  const s = String(raw || 'default').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'default';
}
function getWsFromReq(req) { return resolveWs(req.headers['x-ws'] || req.query?.ws || req.body?.ws || 'default'); }
function parseSlot(req) {
  const full = `${req.baseUrl || ''}${req.path || ''}${req.originalUrl || ''}`;
  const m = /\/accounts\/(A\d+)(\/|$)/i.exec(full);
  return m ? String(m[1]).toUpperCase() : null;
}
function parseAccountAction(req) {
  const m = /\/accounts\/A\d+\/([^/?#]+)/i.exec(String(req.originalUrl || req.url || ''));
  return m ? String(m[1]).toLowerCase() : '';
}

function wsDir(ws) { return path.join(CONFIG_ROOT, 'workspaces', ws); }
function wsLeaseFile(ws) { return path.join(wsDir(ws), 'slot_owner.json'); }
function poolFile() { return path.join(CONFIG_ROOT, 'workers_pool.json'); }
function poolLockFile() { return `${poolFile()}.lock`; }

function ensureWsRuntime(ws) {
  if (!wsRuntime.has(ws)) wsRuntime.set(ws, { lease: null, statusByWorker: new Map(), releaseTimers: new Map() });
  return wsRuntime.get(ws);
}
function loadLease(ws) {
  const rt = ensureWsRuntime(ws);
  if (rt.lease) return rt.lease;
  rt.lease = readJson(wsLeaseFile(ws), {});
  return rt.lease;
}
function saveLease(ws) { writeJson(wsLeaseFile(ws), loadLease(ws)); }
function setLeaseWorker(ws, slot, workerId) { const lease = loadLease(ws); lease[slot] = workerId; saveLease(ws); }
function releaseLease(ws, slot) { const lease = loadLease(ws); delete lease[slot]; saveLease(ws); }

function safeProjectId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}
function projectDir(id) { return wsDir(id); }
function projectMetaFile(id) { return path.join(projectDir(id), 'project.json'); }
function loadProjectMeta(id) { return readJson(projectMetaFile(id), { id, name: id, status: 'STOPPED', workers: [] }); }
function saveProjectMeta(id, meta) { writeJson(projectMetaFile(id), meta); }

function parseProjectNumber(id) {
  const m = String(id || '').match(/^p_(\d+)$/i);
  return m ? Number(m[1]) : null;
}
function normalizeProject(project) {
  if (!project || typeof project !== 'object') return null;
  const id = safeProjectId(project.id);
  if (!id) return null;
  const now = Date.now();
  return {
    id,
    name: String(project.name || id),
    note: project.note != null ? String(project.note) : undefined,
    createdAt: Number(project.createdAt || now),
    updatedAt: Number(project.updatedAt || now),
    status: String(project.status || 'STOPPED').toUpperCase() === 'RUNNING' ? 'RUNNING' : 'STOPPED',
    workers: Array.isArray(project.workers) ? project.workers.map((v) => String(v)).filter(Boolean) : [],
    ...(project.migratedFromName ? { migratedFromName: String(project.migratedFromName) } : {}),
  };
}
function loadProjects() {
  const rows = readJson(PROJECTS_FILE, []);
  return Array.isArray(rows) ? rows.map(normalizeProject).filter(Boolean) : [];
}
function saveProjects(list) {
  const normalized = Array.isArray(list) ? list.map(normalizeProject).filter(Boolean) : [];
  withFileLockSync(`${PROJECTS_FILE}.lock`, () => writeJson(PROJECTS_FILE, normalized));
}
function findProject(id) {
  const pid = safeProjectId(id);
  if (!pid) return null;
  return loadProjects().find((p) => p.id === pid) || null;
}
function upsertProject(project) {
  const next = normalizeProject(project);
  if (!next) throw new Error('invalid project');
  withFileLockSync(`${PROJECTS_FILE}.lock`, () => {
    const list = loadProjects();
    const idx = list.findIndex((p) => p.id === next.id);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    writeJson(PROJECTS_FILE, list);
  });
  return next;
}
function deleteProjectRecord(id) {
  const pid = safeProjectId(id);
  if (!pid) return;
  withFileLockSync(`${PROJECTS_FILE}.lock`, () => {
    const list = loadProjects().filter((p) => p.id !== pid);
    writeJson(PROJECTS_FILE, list);
  });
}
function readProjectCounter() {
  try {
    const n = Number(String(fs.readFileSync(PROJECT_COUNTER_FILE, 'utf-8') || '').trim());
    return Number.isFinite(n) ? n : 100000;
  } catch {
    return 100000;
  }
}
function writeProjectCounter(n) { fs.writeFileSync(PROJECT_COUNTER_FILE, String(n), 'utf-8'); }
function allocateProjectId() {
  return withFileLockSync(`${PROJECT_COUNTER_FILE}.lock`, () => {
    const projects = loadProjects();
    const maxIdNum = projects.reduce((mx, item) => {
      const n = parseProjectNumber(item.id);
      return n && n > mx ? n : mx;
    }, 100000);
    const last = Math.max(readProjectCounter(), maxIdNum, 100000);
    const next = last + 1;
    writeProjectCounter(next);
    return `p_${next}`;
  });
}

function migrateProjects() {
  const raw = readJson(PROJECTS_FILE, []);
  let list = Array.isArray(raw) ? raw : [];
  if (!list.length) {
    const wsRoot = path.join(CONFIG_ROOT, 'workspaces');
    if (fs.existsSync(wsRoot)) {
      list = fs.readdirSync(wsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => readJson(projectMetaFile(d.name), { id: d.name, name: d.name, status: 'STOPPED', workers: [] }));
    }
  }
  const migrated = [];
  let changed = false;

  for (const item of list) {
    const currentId = String(item?.id || '').trim();
    const hasNewId = /^p_\d+$/i.test(currentId);
    if (hasNewId) {
      const normalized = normalizeProject(item);
      if (normalized) migrated.push(normalized);
      continue;
    }

    changed = true;
    const oldId = safeProjectId(currentId || item?.name || '');
    const newId = allocateProjectId();
    const now = Date.now();
    const next = {
      id: newId,
      name: String(item?.name || currentId || newId),
      note: item?.note != null ? String(item.note) : undefined,
      migratedFromName: String(currentId || ''),
      createdAt: Number(item?.createdAt || now),
      updatedAt: now,
      status: 'STOPPED',
      workers: [],
    };
    const oldDir = oldId ? projectDir(oldId) : null;
    const newDir = projectDir(newId);
    if (oldDir && fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
    else ensureDir(newDir);
    saveProjectMeta(newId, next);
    migrated.push(next);
  }

  const unique = [];
  const seen = new Set();
  for (const item of migrated) {
    if (seen.has(item.id)) {
      changed = true;
      continue;
    }
    seen.add(item.id);
    ensureDir(projectDir(item.id));
    saveProjectMeta(item.id, item);
    unique.push(item);
  }

  const maxNum = unique.reduce((mx, item) => {
    const n = parseProjectNumber(item.id);
    return n && n > mx ? n : mx;
  }, 100000);
  if (readProjectCounter() < maxNum) writeProjectCounter(maxNum);

  withFileLockSync(poolLockFile(), () => {
    const pool = loadWorkersPool();
    const valid = new Set(unique.flatMap((p) => (p.workers || []).map((wid) => `${p.id}:${wid}`)));
    for (const w of pool.workers) {
      if (!w.assignedTo) continue;
      if (!unique.find((p) => p.id === w.assignedTo && valid.has(`${p.id}:${w.id}`))) w.assignedTo = null;
    }
    saveWorkersPool(pool);
  });

  if (changed || !Array.isArray(raw)) saveProjects(unique);
}

function buildDefaultPool() {
  return {
    workers: Array.from({ length: WORKER_POOL_SIZE }, (_, i) => ({ id: `w${i + 1}`, port: WORKER_PORT_BASE + i, assignedTo: null })),
    updatedAt: Date.now(),
  };
}
function loadWorkersPool() {
  const file = poolFile();
  if (!fs.existsSync(file)) {
    const p = buildDefaultPool();
    writeJson(file, p);
    return p;
  }
  const p = readJson(file, null);
  if (!p || !Array.isArray(p.workers)) {
    const next = buildDefaultPool();
    writeJson(file, next);
    return next;
  }
  return p;
}
function saveWorkersPool(pool) { pool.updatedAt = Date.now(); writeJson(poolFile(), pool); }

function findContiguousWorkers(pool, count) {
  let run = [];
  for (const w of pool.workers) {
    if (!w.assignedTo) run.push(w);
    else run = [];
    if (run.length === count) return run;
  }
  return null;
}

function getProjectWorkers(project) {
  const pool = loadWorkersPool();
  const byId = new Map(pool.workers.map((w) => [w.id, w]));
  return (project.workers || []).map((id) => byId.get(id)).filter(Boolean);
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

function safeKill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
}

async function ensureWorkerRunning(worker, ws) {
  const running = workers.get(worker.id);
  if (running && running.state === 'running') return running;
  if (running && running.startingPromise) return running.startingPromise;

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
  if (MASTER_TOKEN) env.MASTER_TOKEN = MASTER_TOKEN;

  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: 'inherit' });
  child.on('exit', (code) => {
    log('warn', 'worker_exit', { workerId: worker.id, code });
    workers.set(worker.id, { state: 'stopped', ws });
  });

  const startingPromise = waitWorkerHealth(worker.port).then(() => {
    workers.set(worker.id, { child, state: 'running', ws });
    log('info', 'worker_ready', { workerId: worker.id, port: worker.port, ws });
  });
  workers.set(worker.id, { child, state: 'starting', ws, startingPromise });
  await startingPromise;
  return workers.get(worker.id);
}

async function requestJsonToWorker(worker, method, urlPath, headers = {}, body = null) {
  await ensureWorkerRunning(worker, headers['x-ws'] || headers['X-WS'] || 'default');
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf-8');
    const req = http.request({
      hostname: '127.0.0.1', port: worker.port, path: urlPath, method,
      headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': payload.length } : {}), ...headers },
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

function proxyToWorker(req, res, worker) {
  return new Promise((resolve) => {
    const headers = { ...req.headers, host: `127.0.0.1:${worker.port}` };
    const options = { hostname: '127.0.0.1', port: worker.port, path: req.originalUrl, method: req.method, headers };
    const upstream = http.request(options, (upRes) => {
      res.statusCode = upRes.statusCode || 502;
      for (const [k, v] of Object.entries(upRes.headers || {})) if (v !== undefined) res.setHeader(k, v);
      upRes.pipe(res);
      upRes.on('end', resolve);
    });
    upstream.on('error', (e) => { res.status(502).json({ ok: false, error: String(e?.message || e) }); resolve(); });
    if (req.body && Object.keys(req.body).length > 0 && req.is('application/json')) {
      upstream.write(JSON.stringify(req.body));
      upstream.end();
      return;
    }
    req.pipe(upstream);
  });
}

function isActiveStatus(status) { return ['INIT', 'QR', 'READY', 'AUTH_FAILURE'].includes(String(status || '')); }
function workerActiveCount(ws, workerId) {
  const map = ensureWsRuntime(ws).statusByWorker.get(String(workerId)) || new Map();
  let n = 0;
  for (const st of map.values()) if (isActiveStatus(st)) n++;
  return n;
}

async function reconcileWorkspace(ws) {
  const project = loadProjectMeta(ws);
  const wsWorkers = getProjectWorkers(project);
  if (!wsWorkers.length) return;

  const roles = readJson(path.join(wsDir(ws), 'roles.json'), []);
  const accounts = readJson(path.join(wsDir(ws), 'accounts.json'), []);
  const enabledSlots = new Set((accounts || []).filter((a) => a && a.enabled !== false).map((a) => String(a.slot || '').toUpperCase()));
  const hotSlots = new Set((roles || []).map((r) => String(r?.boundSlot || '').toUpperCase()).filter((s) => /^A\d+$/.test(s) && enabledSlots.has(s)));

  const rt = ensureWsRuntime(ws);
  const lease = loadLease(ws);
  for (const slot of hotSlots) {
    const t = rt.releaseTimers.get(slot);
    if (t) { clearTimeout(t); rt.releaseTimers.delete(slot); }
    if (!lease[slot]) {
      const pick = wsWorkers.find((w) => workerActiveCount(ws, w.id) < MAX_ACTIVE) || wsWorkers[0];
      if (pick) {
        lease[slot] = pick.id;
        saveLease(ws);
        await requestJsonToWorker(pick, 'POST', `/api/accounts/${slot}/connect?force=1`, { 'x-ws': ws, 'x-connect-mode': 'hot' }, {});
      }
    }
  }

  for (const [slot, wid] of Object.entries(lease)) {
    if (hotSlots.has(slot) || rt.releaseTimers.has(slot)) continue;
    const timer = setTimeout(async () => {
      rt.releaseTimers.delete(slot);
      const target = wsWorkers.find((w) => w.id === wid);
      if (target) {
        try { await requestJsonToWorker(target, 'POST', `/api/accounts/${slot}/stop`, { 'x-ws': ws }, {}); } catch {}
      }
      releaseLease(ws, slot);
    }, UNBIND_COOLDOWN_MS);
    rt.releaseTimers.set(slot, timer);
  }
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
  if (MASTER_TOKEN && req.headers['x-master-token'] !== MASTER_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const ws = resolveWs(req.body?.ws);
  const event = String(req.body?.event || '').trim();
  const payload = req.body?.payload ?? {};
  const workerId = String(req.headers['x-worker-id'] || '') || null;
  if (!event) return res.status(400).json({ ok: false, error: 'event required' });

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


function isStartBypassPath(req) {
  const p = String(req.path || req.originalUrl || '');
  if (p.startsWith('/projects')) return true;
  if (p === '/system/recentLogs') return true;
  return false;
}
function ensureProjectRunning(ws) {
  const meta = findProject(ws);
  if (!meta) return { ok: false, reason: 'project not found' };
  if (meta.status !== 'RUNNING') return { ok: false, reason: 'project not started' };
  return { ok: true, meta };
}

app.get('/api/system/recentLogs', (_req, res) => res.json({ ok: true, logs: RECENT_LOGS }));
app.get('/health', (_req, res) => {
  const pool = loadWorkersPool();
  res.json({ ok: true, master: { port: PORT_MASTER }, workers: pool.workers.map((w) => ({ ...w, running: workers.get(w.id)?.state === 'running' })) });
});

app.get('/api/accounts', (req, res) => {
  const ws = getWsFromReq(req);
  const running = ensureProjectRunning(ws);
  if (!running.ok) return res.status(409).json({ ok: false, error: running.reason });
  const rows = readJson(path.join(wsDir(ws), 'accounts.json'), []);
  return res.json({ ok: true, data: rows });
});
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
app.get('/api/groups', (req, res) => {
  const ws = getWsFromReq(req);
  const running = ensureProjectRunning(ws);
  if (!running.ok) return res.status(409).json({ ok: false, error: running.reason });
  return res.json({ ok: true, rows: readJson(path.join(wsDir(ws), 'groups.json'), []) });
});

app.get('/api/projects', (_req, res) => {
  const rows = loadProjects().map((item) => ({ ...item, workers: Array.isArray(item.workers) ? item.workers : [] }));
  return res.json({ ok: true, data: rows, rows, projects: rows });
});
app.get('/api/projects/:id', (req, res) => {
  const id = safeProjectId(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const project = findProject(id);
  if (!project) return res.status(404).json({ ok: false, error: 'project not found' });
  return res.json({ ok: true, data: project });
});
app.post('/api/projects', (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    const id = allocateProjectId();
    const now = Date.now();
    const project = {
      id,
      name,
      ...(body.note != null ? { note: String(body.note) } : {}),
      createdAt: now,
      updatedAt: now,
      status: 'STOPPED',
      workers: [],
    };
    ensureDir(projectDir(id));
    saveProjectMeta(id, project);
    upsertProject(project);
    return res.json({ ok: true, data: project });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.put('/api/projects/:id', (req, res) => {
  const id = safeProjectId(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const meta = findProject(id);
  if (!meta) return res.status(404).json({ ok: false, error: 'project not found' });
  const now = Date.now();
  const next = {
    ...meta,
    name: String(req.body?.name || meta.name || id),
    ...(req.body?.note != null ? { note: String(req.body.note) } : { note: meta.note }),
    updatedAt: now,
  };
  saveProjectMeta(id, next);
  upsertProject(next);
  return res.json({ ok: true, data: next });
});
app.post('/api/projects/:id/start', async (req, res) => {
  try {
    const id = safeProjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const meta = findProject(id);
    if (!meta) return res.status(404).json({ ok: false, error: 'project not found' });
    if (!Array.isArray(meta.workers) || meta.workers.length !== WORKERS_PER_PROJECT) {
      withFileLockSync(poolLockFile(), () => {
        const pool = loadWorkersPool();
        for (const w of pool.workers) if (meta.workers?.includes(w.id)) w.assignedTo = null;
        const block = findContiguousWorkers(pool, WORKERS_PER_PROJECT);
        if (!block) throw new Error('no contiguous workers available');
        meta.workers = block.map((w) => w.id);
        for (const w of block) w.assignedTo = id;
        saveWorkersPool(pool);
      });
    }
    const wsWorkers = getProjectWorkers(meta);
    for (const w of wsWorkers) await ensureWorkerRunning(w, id);
    meta.status = 'RUNNING';
    meta.updatedAt = Date.now();
    saveProjectMeta(id, meta);
    upsertProject(meta);
    await reconcileWorkspace(id);
    return res.json({ ok: true, data: meta });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.post('/api/projects/:id/stop', (req, res) => {
  try {
    const id = safeProjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const meta = findProject(id);
    if (!meta) return res.status(404).json({ ok: false, error: 'project not found' });
    for (const wid of (meta.workers || [])) {
      const running = workers.get(wid);
      if (running?.child) safeKill(running.child);
      workers.set(wid, { state: 'stopped', ws: id });
    }
    meta.status = 'STOPPED';
    meta.updatedAt = Date.now();
    saveProjectMeta(id, meta);
    upsertProject(meta);
    return res.json({ ok: true, data: meta });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.delete('/api/projects/:id', (req, res) => {
  try {
    const id = safeProjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const meta = findProject(id);
    if (!meta) return res.status(404).json({ ok: false, error: 'project not found' });
    for (const wid of (meta.workers || [])) {
      const running = workers.get(wid);
      if (running?.child) safeKill(running.child);
    }
    withFileLockSync(poolLockFile(), () => {
      const pool = loadWorkersPool();
      for (const w of pool.workers) if (w.assignedTo === id) w.assignedTo = null;
      saveWorkersPool(pool);
    });
    fs.rmSync(projectDir(id), { recursive: true, force: true });
    deleteProjectRecord(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.use('/api', async (req, res) => {
  try {
    const ws = resolveWs(req.headers['x-ws'] || req.query?.ws || 'default');
    if (!isStartBypassPath(req)) {
      const running = ensureProjectRunning(ws);
      if (!running.ok) return res.status(409).json({ ok: false, error: running.reason });
    }
    const slot = parseSlot(req);
    const meta = findProject(ws);
    if (!meta) return res.status(404).json({ ok: false, error: 'project not found' });
    const wsWorkers = getProjectWorkers(meta);
    if (!wsWorkers.length) return res.status(409).json({ ok: false, error: 'project has no workers' });

    if (!slot) {
      if (req.path.startsWith('/groups') || req.path.startsWith('/roles') || req.path.startsWith('/projects') || req.path.startsWith('/accounts')) {
        return res.status(404).json({ ok: false, error: 'route not handled by master' });
      }
      await ensureWorkerRunning(wsWorkers[0], ws);
      return proxyToWorker(req, res, wsWorkers[0]);
    }

    const action = parseAccountAction(req);
    const lease = loadLease(ws);
    let target = null;

    if (req.method === 'POST' && action === 'connect') {
      target = wsWorkers.find((w) => workerActiveCount(ws, w.id) < MAX_ACTIVE) || null;
      if (!target) return res.status(409).json({ ok: false, error: 'all workers reached max active' });
      lease[slot] = target.id;
      saveLease(ws);
    } else {
      const owner = lease[slot];
      target = wsWorkers.find((w) => w.id === owner) || wsWorkers[0];
    }

    if (!target) return res.status(409).json({ ok: false, error: 'no target worker' });
    await ensureWorkerRunning(target, ws);
    return proxyToWorker(req, res, target);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

server.listen(PORT_MASTER, () => {
  ensureDir(path.join(CONFIG_ROOT, 'workspaces'));
  ensureDir(WORK_ROOT);
  if (!fs.existsSync(PROJECTS_FILE)) writeJson(PROJECTS_FILE, []);
  if (!fs.existsSync(PROJECT_COUNTER_FILE)) fs.writeFileSync(PROJECT_COUNTER_FILE, '100000', 'utf-8');
  migrateProjects();
  loadWorkersPool();
  log('info', 'master_listen', { port: PORT_MASTER, workerPoolSize: WORKER_POOL_SIZE });
});
