// wa-gateway/server.js（把“文件开头”到 ensureDataFiles(); 这一段，整段替换成下面）

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require('os');

// =====================================================
// ✅ 统一数据根目录：优先使用环境变量 DATA_DIR，否则默认 AppData
// =====================================================
function getDefaultRoot() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, '@ws-manager', 'wa-gateway-data');
}
const DEFAULT_ROOT = getDefaultRoot();
const DEFAULT_CONFIG_ROOT = path.join(DEFAULT_ROOT, 'data');
const DEFAULT_WORK_ROOT = path.join(DEFAULT_ROOT, 'work');

// DATA_ROOT 作为所有运行时数据的顶层目录（包括 .wwebjs_auth, .wwebjs_cache, data, _uploads 等）
const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : DEFAULT_ROOT;  // 没有 DATA_DIR 时使用 AppData 默认

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 统一把最终根写回 env（后面其他模块/函数也可直接用）
process.env.DATA_DIR = DATA_ROOT;
ensureDir(DATA_ROOT);

// 你迁移过来的目录结构就是放在 DATA_ROOT 下：
//   .wwebjs_auth / .wwebjs_cache / data / _uploads
const AUTH_ROOT = ensureDir(path.join(DATA_ROOT, ".wwebjs_auth"));
const CACHE_ROOT = ensureDir(path.join(DATA_ROOT, ".wwebjs_cache"));
const DATA_DIR = ensureDir(path.join(DATA_ROOT, "data"));
const UPLOADS_DIR = ensureDir(path.join(DATA_ROOT, "_uploads"));

// ---------- 持久化（统一放 DATA_DIR 下） ----------
const WORKSPACES_DIR = ensureDir(path.join(DATA_DIR, "workspaces"));
const AUTH_DATA_DIR = ensureDir(path.join(DATA_DIR, "wwebjs_auth"));
const CACHE_DATA_DIR = ensureDir(path.join(DATA_DIR, ".wwebjs_cache"));
const TRASH_DIR = ensureDir(path.join(DATA_DIR, "_trash"));
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const PROJECT_COUNTER_FILE = path.join(DATA_DIR, "project_counter.txt");
const SCHEDULED_HISTORY_LIMIT = 200;
const HISTORY_LIMIT = 5000;

// UID 计数文件
const UID_COUNTER_FILE = path.join(DATA_DIR, "uid_counter.txt");
const UID_START = 100001;
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TRASH_CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_INIT = Math.max(1, Number(process.env.MAX_INIT || process.env.WA_INIT_CONCURRENCY || 3));
const MAX_ACTIVE = Math.max(1, Number(process.env.MAX_ACTIVE || 30));
const WORKSPACE_ID = String(process.env.WORKSPACE_ID || '').trim();
const WARMUP_LIMIT = Math.max(0, Number(process.env.WARMUP_LIMIT || 10));
const MASTER_INTERNAL_URL = String(process.env.MASTER_INTERNAL_URL || '').trim();
const IS_MASTER_MODE = !!MASTER_INTERNAL_URL;
const MASTER_TOKEN = String(process.env.MASTER_TOKEN || '').trim();

// ✅ CONFIG_ROOT：共享配置根（读写 accounts/roles/groups/...）
const CONFIG_ROOT = path.resolve(
  process.env.CONFIGDIR ||
  path.join(DATA_ROOT, "data")
);

// ✅ WORK_ROOT：运行态根（wwebjs_auth/浏览器 profile 等）
// worker 模式下 master 会传 WORKDIR（例如 ...\work\w1）；单 worker 模式可用 DEFAULT_WORK_ROOT
const WORK_ROOT = path.resolve(
  process.env.WORKDIR ||
  path.join(DATA_ROOT, "work")
);

const RECENT_LOG_LIMIT = Math.max(10, Number(process.env.RECENT_LOG_LIMIT || 200));
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };
const RECENT_LOGS = [];

function shouldLog(level) {
  const current = LOG_LEVEL_WEIGHT[LOG_LEVEL] || LOG_LEVEL_WEIGHT.info;
  const target = LOG_LEVEL_WEIGHT[level] || LOG_LEVEL_WEIGHT.info;
  return target >= current;
}

function log(level, event, fields = {}) {
  const row = { ts: new Date().toISOString(), level, event, ...fields };
  RECENT_LOGS.push(row);
  if (RECENT_LOGS.length > RECENT_LOG_LIMIT) RECENT_LOGS.splice(0, RECENT_LOGS.length - RECENT_LOG_LIMIT);
  if (shouldLog(level)) process.stdout.write(`${JSON.stringify(row)}\n`);
}

function withFileLockSync(lockFile, fn, timeoutMs = 15000, pollMs = 40) {
  const start = Date.now();
  while (true) {
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fd = fs.openSync(lockFile, 'wx');
      return fn();
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lock timeout: ${lockFile}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
    } finally {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
    }
  }
}

// ② ensureDataFiles()：创建必要文件/目录（不会再碰 __dirname/data）
function ensureDataFiles() {
  ensureDir(DATA_ROOT);
  ensureDir(AUTH_ROOT);
  ensureDir(CACHE_ROOT);
  ensureDir(DATA_DIR);
  ensureDir(WORKSPACES_DIR);
  ensureDir(AUTH_DATA_DIR);
  ensureDir(CACHE_DATA_DIR);
  ensureDir(TRASH_DIR);
  ensureDir(UPLOADS_DIR);
  ensureDir(CONFIG_ROOT);
  ensureDir(WORK_ROOT);
  ensureDir(path.join(CONFIG_ROOT, 'workspaces'));
  ensureDir(path.join(WORK_ROOT, 'workspaces'));

  if (!fs.existsSync(PROJECTS_FILE)) fs.writeFileSync(PROJECTS_FILE, "[]", "utf-8");
  if (!fs.existsSync(PROJECT_COUNTER_FILE)) fs.writeFileSync(PROJECT_COUNTER_FILE, "100000", "utf-8");
  if (!fs.existsSync(UID_COUNTER_FILE))
    fs.writeFileSync(UID_COUNTER_FILE, String(UID_START - 1), "utf-8");
}
ensureDataFiles();
log('info', 'gateway_paths_ready', { DATA_ROOT, CONFIG_ROOT, WORK_ROOT });

// ===============================
// ✅ Workspace 路径统一（全部落在 DATA_DIR/workspaces/...）
// ===============================
function normalizeWs(ws) {
  const s = String(ws || "default").trim();
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

// =====================================================
// Express / Socket.IO
// =====================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', enforceWorkspace);


const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/health", (req, res) => {
  const ws = getWs(req);
  res.json({
    ok: true,
    worker: {
      port: Number(process.env.PORT || 3001),
      active: getActiveCount(ws),
      maxActive: MAX_ACTIVE,
    },
    ts: Date.now(),
  });
});

// =========================
// Auth proxy (avoid CORS)
// Frontend -> http://127.0.0.1:3001/api/auth/login
// Gateway  -> https://auth.tg自动化.xyz/api/login
// =========================
const https = require("https");

const AUTH_BASE_URL = process.env.AUTH_BASE_URL || "https://auth.tg自动化.xyz"; 
// 如果你担心中文域名兼容，可改成：
// const AUTH_BASE_URL = process.env.AUTH_BASE_URL || "https://auth.xn--tg-2r5c9pp74q.xyz";

function httpsPostJson(urlStr, payload, extraHeaders = {}) {
  const u = new URL(urlStr);
  const body = Buffer.from(JSON.stringify(payload || {}), "utf-8");

  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + (u.search || ""),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Content-Length": body.length,
      ...extraHeaders,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {}
        resolve({ status: res.statusCode || 0, json, text: data });
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password, device_id } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "missing username/password" });
    }

    const upstream = `${AUTH_BASE_URL}/api/login`;
    const r = await httpsPostJson(upstream, {
      username: String(username).trim(),
      password: String(password),
      device_id: device_id ?? null,
    });

    // 透传上游返回
    if (r.status >= 200 && r.status < 300) {
      return res.json(r.json || {});
    }

    return res.status(r.status || 502).json({
      ok: false,
      error: r.json?.detail || r.json?.message || r.text || `upstream status ${r.status}`,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/auth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) {
      return res.status(400).json({ ok: false, error: "missing refresh_token" });
    }

    const upstream = `${AUTH_BASE_URL}/api/refresh`;
    const r = await httpsPostJson(upstream, { refresh_token: String(refresh_token) });

    if (r.status >= 200 && r.status < 300) {
      return res.json(r.json || {});
    }

    return res.status(r.status || 502).json({
      ok: false,
      error: r.json?.detail || r.json?.message || r.text || `upstream status ${r.status}`,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =====================================================
// Upload（统一写到 DATA_ROOT/_uploads）
// =====================================================
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 64 * 1024 * 1024 }, // 64MB
});

// scheduleUpload：你原本的逻辑不动，但它最终写入的目录建议也基于 WORKSPACES_DIR / DATA_DIR
const scheduleUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const ws = getWs(req);
      const jobId = req.scheduleId || newId();
      req.scheduleId = jobId;
      const dir = ensureSchedulesUploadDir(ws, jobId);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safeName = String(file.originalname || "file").replace(/[^A-Za-z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safeName}`);
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024 },
});

// ===== JSON helpers (atomic) =====
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    const bak = file + '.bak';
    if (fs.existsSync(bak)) {
      log('warn', 'json_recover_from_bak', { file, bak, reason: String(err?.message || err || 'unknown') });
    }
    try {
      const recovered = JSON.parse(fs.readFileSync(bak, 'utf-8'));
      try {
        const tmp = file + '.tmp';
        const fd = fs.openSync(tmp, 'w');
        try {
          fs.writeFileSync(fd, JSON.stringify(recovered, null, 2), 'utf-8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
        log('info', 'json_recover_restored', { file, bak });
      } catch {}
      return recovered;
    } catch {
      return fallback;
    }
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = file + '.bak';
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, bak); } catch {}
  }
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
function formatTrashTs(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
function removeDirSafe(target) {
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  } catch {}
}
function copyDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true, force: true });
    return;
  }

  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyDir(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  fs.copyFileSync(src, dst);
}
function safeMoveToTrash(src, type, id) {
  if (!src || !fs.existsSync(src)) return null;
  const stamp = formatTrashTs();
  const dst = path.join(TRASH_DIR, safeId(type) || 'misc', stamp, safeId(id) || 'unknown');
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  try {
    fs.renameSync(src, dst);
    return dst;
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    copyDir(src, dst);
    removeDirSafe(src);
    return dst;
  }
}
function collectTrashLeafDirs(base, list = []) {
  if (!fs.existsSync(base)) return list;
  for (const typeName of fs.readdirSync(base)) {
    const typeDir = path.join(base, typeName);
    if (!fs.statSync(typeDir).isDirectory()) continue;
    for (const tsName of fs.readdirSync(typeDir)) {
      const tsDir = path.join(typeDir, tsName);
      if (!fs.statSync(tsDir).isDirectory()) continue;
      for (const idName of fs.readdirSync(tsDir)) {
        const idDir = path.join(tsDir, idName);
        if (!fs.statSync(idDir).isDirectory()) continue;
        list.push({ typeDir, tsDir, idDir });
      }
    }
  }
  return list;
}
function cleanupTrash() {
  const now = Date.now();
  const leaves = collectTrashLeafDirs(TRASH_DIR);
  for (const item of leaves) {
    try {
      const st = fs.statSync(item.idDir);
      if (now - st.mtimeMs > TRASH_RETENTION_MS) {
        fs.rmSync(item.idDir, { recursive: true, force: true });
      }
      if (fs.existsSync(item.tsDir) && fs.readdirSync(item.tsDir).length === 0) fs.rmdirSync(item.tsDir);
      if (fs.existsSync(item.typeDir) && fs.readdirSync(item.typeDir).length === 0) fs.rmdirSync(item.typeDir);
    } catch {}
  }
}
function safeId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}
function nowIso() { return new Date().toISOString(); }
function newId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function resolveWs(raw) {
  const ws = safeId(raw);
  return ws || 'default';
}

function getWs(req) {
  const raw = req.query?.ws || req.headers['x-ws'] || 'default';
  return resolveWs(raw);
}

function enforceWorkspace(req, res, next) {
  if (!WORKSPACE_ID) return next();
  const ws = getWs(req);
  if (ws !== WORKSPACE_ID) {
    return res.status(409).json({ ok: false, error: `workspace mismatch: worker=${WORKSPACE_ID}, request=${ws}` });
  }
  return next();
}

function getWorkspaceConfigDir(ws) {
  return path.join(CONFIG_ROOT, 'workspaces', safeId(ws) || 'default');
}
function getWorkspaceWorkDir(ws) {
  return path.join(WORK_ROOT, 'workspaces', safeId(ws) || 'default');
}
function getWorkspaceDir(ws) {
  return getWorkspaceWorkDir(ws);
}
function getLegacyWorkspaceDir(ws) {
  return path.join(WORKSPACES_DIR, safeId(ws) || 'default');
}
function maybeMigrateLegacyFile(primary, legacy) {
  if (primary === legacy) return;
  if (fs.existsSync(primary) || !fs.existsSync(legacy)) return;
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  try { fs.copyFileSync(legacy, primary); } catch {}
}
function getWorkspaceAccountsFile(ws) {
  const file = path.join(getWorkspaceConfigDir(ws), 'accounts.json');
  maybeMigrateLegacyFile(file, path.join(getLegacyWorkspaceDir(ws), 'accounts.json'));
  return file;
}
function getWorkspaceGroupsFile(ws) {
  const file = path.join(getWorkspaceConfigDir(ws), 'groups.json');
  maybeMigrateLegacyFile(file, path.join(getLegacyWorkspaceDir(ws), 'groups.json'));
  return file;
}
function getWorkspaceRolesFile(ws) {
  const file = path.join(getWorkspaceConfigDir(ws), 'roles.json');
  maybeMigrateLegacyFile(file, path.join(getLegacyWorkspaceDir(ws), 'roles.json'));
  return file;
}
function getWorkspaceHistoryFile(ws) {
  const file = path.join(getWorkspaceConfigDir(ws), 'history.json');
  maybeMigrateLegacyFile(file, path.join(getLegacyWorkspaceDir(ws), 'history.json'));
  return file;
}
function getWorkspaceSchedulesFile(ws) {
  const file = path.join(getWorkspaceConfigDir(ws), 'scheduled_jobs.json');
  maybeMigrateLegacyFile(file, path.join(getLegacyWorkspaceDir(ws), 'scheduled_jobs.json'));
  return file;
}
function getWorkspaceSchedulesHistoryFile(ws) {
  const file = path.join(getWorkspaceConfigDir(ws), 'scheduled_jobs_history.json');
  maybeMigrateLegacyFile(file, path.join(getLegacyWorkspaceDir(ws), 'scheduled_jobs_history.json'));
  return file;
}
function getWorkspaceSchedulesUploadsDir(ws, jobId) {
  if (jobId) return path.join(getWorkspaceWorkDir(ws), 'scheduled_uploads', jobId);
  return path.join(getWorkspaceWorkDir(ws), 'scheduled_uploads');
}
function getWorkspaceAuthDir(ws) {
  return path.join(getWorkspaceWorkDir(ws), 'wwebjs_auth');
}
function getWorkspaceConfigFileLock(file) {
  return `${file}.lock`;
}
function ensureSessionCompat(ws, sessionDir) {
  const sid = String(sessionDir || '').trim();
  if (!sid) return;
  const target = path.join(getWorkspaceAuthDir(ws), sid);
  if (fs.existsSync(target)) return;
  const candidates = [
    path.join(getLegacyWorkspaceDir(ws), 'wwebjs_auth', sid),
    path.join(AUTH_DATA_DIR, sid),
  ];
  for (const legacy of candidates) {
    if (!fs.existsSync(legacy)) continue;
    try {
      copyDir(legacy, target);
      log('info', 'auth_session_migrated', { ws, sessionDir: sid, from: legacy, to: target });
      break;
    } catch {}
  }
}
function ensureWorkspace(ws) {
  const configDir = getWorkspaceConfigDir(ws);
  const workDir = getWorkspaceWorkDir(ws);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const groupsFile = getWorkspaceGroupsFile(ws);
  if (!fs.existsSync(groupsFile)) writeJson(groupsFile, []);
  const rolesFile = getWorkspaceRolesFile(ws);
  if (!fs.existsSync(rolesFile)) writeJson(rolesFile, defaultRoles());
  const historyFile = getWorkspaceHistoryFile(ws);
  if (!fs.existsSync(historyFile)) writeJson(historyFile, []);
}

function loadGroups(ws) {
  const file = getWorkspaceGroupsFile(ws);
  const data = readJson(file, []);
  return Array.isArray(data) ? data : [];
}

function saveGroups(ws, list) {
  const file = getWorkspaceGroupsFile(ws);
  withFileLockSync(getWorkspaceConfigFileLock(file), () => {
    writeJson(file, Array.isArray(list) ? list : []);
  });
}

function defaultRoles() {
  const roles = [];
  const push = (remark) => roles.push({ id: remark, remark, name: '', boundSlot: '' });

  push('admin');
  push('老师');
  push('助理');
  for (let i = 1; i <= 15; i++) push(`老手${i}`);
  for (let i = 1; i <= 15; i++) push(`新手${i}`);

  return roles;
}

function loadRoles(ws) {
  ensureWorkspace(ws);
  const file = getWorkspaceRolesFile(ws);
  const data = readJson(file, null);
  return Array.isArray(data) ? data : defaultRoles();
}

function saveRoles(ws, list) {
  const file = getWorkspaceRolesFile(ws);
  withFileLockSync(getWorkspaceConfigFileLock(file), () => {
    writeJson(file, Array.isArray(list) ? list : []);
  });
}

function loadHistory(ws) {
  const file = getWorkspaceHistoryFile(ws);
  const data = readJson(file, []);
  return Array.isArray(data) ? data : [];
}

function saveHistory(ws, list) {
  const file = getWorkspaceHistoryFile(ws);
  const rows = Array.isArray(list) ? list.slice(-HISTORY_LIMIT) : [];
  withFileLockSync(getWorkspaceConfigFileLock(file), () => {
    writeJson(file, rows);
  });
}

function loadProjects() {
  const data = readJson(PROJECTS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveProjects(list) {
  withFileLockSync(`${PROJECTS_FILE}.lock`, () => {
    writeJson(PROJECTS_FILE, list);
  });
}
function ensureWorkspaceDir(id) {
  fs.mkdirSync(getWorkspaceConfigDir(id), { recursive: true });
  fs.mkdirSync(getWorkspaceWorkDir(id), { recursive: true });
}
function getCountsForWorkspace(id) {
  const accounts = readJson(getWorkspaceAccountsFile(id), []);
  const groups = readJson(getWorkspaceGroupsFile(id), []);
  return {
    accountsCount: Array.isArray(accounts) ? accounts.length : 0,
    groupsCount: Array.isArray(groups) ? groups.length : 0,
  };
}
function parseProjectNumber(id) {
  const m = String(id || '').match(/^p_(\d{6,})$/);
  return m ? Number(m[1]) : null;
}
function readProjectCounter() {
  try {
    const n = Number(String(fs.readFileSync(PROJECT_COUNTER_FILE, 'utf-8') || '').trim());
    return Number.isFinite(n) ? n : 100000;
  } catch {
    return 100000;
  }
}
function writeProjectCounter(n) {
  fs.writeFileSync(PROJECT_COUNTER_FILE, String(n), 'utf-8');
}
function allocateProjectId() {
  const next = Math.max(readProjectCounter() + 1, 100001);
  writeProjectCounter(next);
  return `p_${String(next).padStart(6, '0')}`;
}

function migrateProjects() {
  const rawList = loadProjects();
  const list = Array.isArray(rawList) ? rawList : [];
  if (!list.length) {
    const counter = readProjectCounter();
    if (counter < 100000) writeProjectCounter(100000);
    return;
  }

  const oldNameCount = new Map();
  for (const item of list) {
    const idAsName = String(item?.name || item?.id || '').trim();
    if (!idAsName) continue;
    oldNameCount.set(idAsName, (oldNameCount.get(idAsName) || 0) + 1);
  }

  const inheritedByOldName = new Set();
  const migrated = [];
  let changed = false;

  for (const item of list) {
    const currentId = String(item?.id || '').trim();
    const hasNewId = /^p_\d{6,}$/.test(currentId);
    const oldName = String(item?.name || item?.id || '').trim() || '未命名任务';

    const now = nowIso();
    const next = {
      ...item,
      id: hasNewId ? currentId : allocateProjectId(),
      name: oldName,
      note: item?.note != null ? String(item.note) : '',
      createdAt: item?.createdAt || now,
      updatedAt: now,
    };

    if (!hasNewId) {
      changed = true;
      const oldDir = getWorkspaceConfigDir(oldName);
      const newDir = getWorkspaceConfigDir(next.id);
      const duplicated = (oldNameCount.get(oldName) || 0) > 1;

      if (fs.existsSync(oldDir) && !inheritedByOldName.has(oldName)) {
        inheritedByOldName.add(oldName);
        if (oldDir !== newDir) {
          if (!fs.existsSync(newDir)) {
            fs.renameSync(oldDir, newDir);
          } else {
            ensureWorkspaceDir(next.id);
          }
        }
      } else {
        ensureWorkspaceDir(next.id);
        if (duplicated) next.migratedFromName = oldName;
      }
    }

    ensureWorkspace(next.id);
    migrated.push(next);
  }

  // 去重防异常：同 id 仅保留第一个
  const unique = [];
  const seen = new Set();
  for (const item of migrated) {
    if (seen.has(item.id)) {
      changed = true;
      continue;
    }
    seen.add(item.id);
    unique.push(item);
  }

  const maxNum = unique.reduce((mx, item) => {
    const n = parseProjectNumber(item.id);
    return n && n > mx ? n : mx;
  }, 100000);
  const currentCounter = readProjectCounter();
  if (currentCounter < maxNum) writeProjectCounter(maxNum);

  if (changed) saveProjects(unique);
}

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
function saveAccounts(ws, list) {
  const file = getWorkspaceAccountsFile(ws);
  withFileLockSync(getWorkspaceConfigFileLock(file), () => {
    writeJson(file, list);
  });
}
function normalizeSlot(s) {
  return String(s || '').trim();
}
function isValidSlot(slot) {
  return /^A\d+$/i.test(String(slot || '').trim());
}
function slotToNumber(slot) {
  const m = /^A(\d+)$/i.exec(String(slot || '').trim());
  return m ? Number(m[1]) : null;
}

function slotInWorkerRange(_slot) {
  return true;
}

function ensureSlotOwned(_res, _slot) {
  return true;
}
function getAccountBySlot(ws, slot) {
  const list = loadAccounts(ws);
  return list.find(x => x.slot === slot) || null;
}

// ③ 新增：递增 uid 分配器（整段复制粘贴）
function readLastUid() {
  try {
    const n = Number(String(fs.readFileSync(UID_COUNTER_FILE, 'utf-8') || '').trim());
    return Number.isFinite(n) ? n : (UID_START - 1);
  } catch {
    return (UID_START - 1);
  }
}

function writeLastUid(n) {
  fs.writeFileSync(UID_COUNTER_FILE, String(n), 'utf-8');
}

// ✅ uid 从 100001 递增；同时用 accounts.json 去重（防你手动改文件导致撞号）
function allocateNextUid(currentAccountsList) {
  const used = new Set(
    (currentAccountsList || [])
      .map(x => String(x?.uid || '').trim())
      .filter(Boolean)
  );

  // 如果 accounts.json 里已经有更大的数字 uid，就把 last 抬上去（防 counter 回退）
  let last = readLastUid();
  for (const u of used) {
    const n = Number(u);
    if (Number.isFinite(n) && n > last) last = n;
  }

  let next = Math.max(last + 1, UID_START);
  while (used.has(String(next))) next++;

  writeLastUid(next);
  return String(next); // uid 一律用字符串更稳
}

function buildSessionDir(uid) {
  const v = String(uid || '').trim();
  return v ? `session-${v}` : '';
}

function ensureAccount(ws, slot) {
  slot = normalizeSlot(slot);
  if (!slot) throw new Error('slot empty');
  if (!isValidSlot(slot)) throw new Error('slot format must be A1/A2/...');

  ensureWorkspace(ws);
  const file = getWorkspaceAccountsFile(ws);
  return withFileLockSync(getWorkspaceConfigFileLock(file), () => {
    const list = loadAccounts(ws);
    let acc = list.find(x => x.slot === slot);
    if (!acc) {
      const uid = allocateNextUid(list);
      acc = { slot, uid, sessionDir: buildSessionDir(uid), createdAt: Date.now(), enabled: true };
      list.push(acc);
      writeJson(file, list);
    }
    return acc;
  });
}
function listAccountsSorted(ws) {
  const list = loadAccounts(ws);
  return list.slice().sort((a, b) => String(a.slot).localeCompare(String(b.slot), 'en', { numeric: true }));
}
function nextSlotLabel(list) {
  let max = 0;
  for (const a of list) {
    const m = /^A(\d+)$/i.exec(String(a.slot || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `A${max + 1}`;
}

function loadScheduledJobs(ws) {
  const file = getWorkspaceSchedulesFile(ws);
  const data = readJson(file, []);
  return Array.isArray(data) ? data : [];
}
function saveScheduledJobs(ws, list) {
  const file = getWorkspaceSchedulesFile(ws);
  withFileLockSync(getWorkspaceConfigFileLock(file), () => {
    writeJson(file, list);
  });
}
function removeScheduledJob(ws, id) {
  const list = loadScheduledJobs(ws);
  const next = list.filter(job => job.id !== id);
  if (next.length !== list.length) saveScheduledJobs(ws, next);
  return list.find(job => job.id === id) || null;
}
function loadScheduledHistory(ws) {
  const file = getWorkspaceSchedulesHistoryFile(ws);
  const data = readJson(file, []);
  return Array.isArray(data) ? data : [];
}
function saveScheduledHistory(ws, list) {
  const file = getWorkspaceSchedulesHistoryFile(ws);
  withFileLockSync(getWorkspaceConfigFileLock(file), () => {
    writeJson(file, list.slice(0, SCHEDULED_HISTORY_LIMIT));
  });
}
function archiveScheduledJob(ws, job) {
  const list = loadScheduledHistory(ws);
  const next = [job, ...list].slice(0, SCHEDULED_HISTORY_LIMIT);
  saveScheduledHistory(ws, next);
}

function ensureSchedulesUploadDir(ws, jobId) {
  const dir = getWorkspaceSchedulesUploadsDir(ws, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanupScheduledUploads(ws, jobId) {
  if (!jobId) return;
  const dir = getWorkspaceSchedulesUploadsDir(ws, jobId);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------- 运行态：按 ws 分桶 ----------
const contexts = new Map(); // ws -> { clients, statuses, profiles }
const CONNECT_INFLIGHT = new Map();
const SLOT_QUEUES = new Map();
let initRunning = 0;
const initQueue = [];

function inflightKey(ws, slot) {
  return `${ws}::${slot}`;
}

function enqueueSlot(ws, slot, fn) {
  const key = inflightKey(ws, slot);
  const prev = SLOT_QUEUES.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  SLOT_QUEUES.set(key, run.finally(() => {
    if (SLOT_QUEUES.get(key) === run) SLOT_QUEUES.delete(key);
  }));
  return run;
}

async function singleflight(ws, slot, fn) {
  const k = inflightKey(ws, slot);
  if (CONNECT_INFLIGHT.has(k)) return CONNECT_INFLIGHT.get(k);
  const p = (async () => fn())().finally(() => CONNECT_INFLIGHT.delete(k));
  CONNECT_INFLIGHT.set(k, p);
  return p;
}

async function withInitLimit(fn) {
  if (initRunning >= MAX_INIT) {
    await new Promise(resolve => initQueue.push(resolve));
  }
  initRunning += 1;
  try {
    return await fn();
  } finally {
    initRunning -= 1;
    const next = initQueue.shift();
    if (next) next();
  }
}

async function restoreAndFocus(page) {
  if (!page) return;

  try {
    const target = page.target();
    const cdp = await target.createCDPSession();
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' },
    });

    const tid =
      (typeof target.targetId === 'function' ? target.targetId() : null) ||
      target._targetId;
    if (tid) {
      try { await cdp.send('Target.activateTarget', { targetId: tid }); } catch {}
    }
  } catch {}

  try { await page.bringToFront(); } catch {}
}

function isDetachedErr(e) {
  const msg = String(e?.message || e);
  return msg.includes('detached Frame') || msg.includes('Execution context was destroyed');
}

async function retryDetached(fn, pageGetter, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isDetachedErr(e) || i === retries) throw e;
      const page = await pageGetter();
      try { await page?.reload?.({ waitUntil: 'domcontentloaded' }); } catch {}
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw last;
}

async function destroyClient(ws, slot) {
  const { clients, statuses, profiles } = ctx(ws);
  const client = clients.get(slot);
  if (client) {
    try { await client.destroy(); } catch {}
    clients.delete(slot);
  }
  profiles.delete(slot);
  statuses.set(slot, { status: 'DISCONNECTED', lastQr: null });
}

function ctx(ws) {
  const key = safeId(ws) || 'default';
  if (!contexts.has(key)) {
    contexts.set(key, {
      clients: new Map(),
      statuses: new Map(),
      profiles: new Map(),
    });
  }
  return contexts.get(key);
}

function getActiveCount(ws) {
  return ctx(ws).clients.size;
}

function hasWorkerCapacity(ws) {
  return getActiveCount(ws) < MAX_ACTIVE;
}

function postJson(urlStr, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const data = Buffer.from(JSON.stringify(payload || {}), 'utf-8');
      const req = http.request({
        hostname: u.hostname,
        port: Number(u.port || 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          ...headers,
        },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function emitWsEvent(ws, event, payload) {
  io.to(ws).emit(event, payload);
  if (!MASTER_INTERNAL_URL) return;
  const headers = MASTER_TOKEN ? { 'x-master-token': MASTER_TOKEN } : {};
  if (process.env.WORKER_ID) headers['x-worker-id'] = String(process.env.WORKER_ID);
  postJson(`${MASTER_INTERNAL_URL}/internal/emit`, { ws, event, payload }, headers)
    .catch((e) => {
      log('warn', 'master_emit_failed', { ws, event, err: String(e?.message || e) });
    });
}

async function runPool(items, worker, concurrency) {
  let idx = 0;
  const results = new Array(items.length).fill(false);
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function getClientReady(ws, slot) {
  const { clients, statuses } = ctx(ws);
  const client = clients.get(slot);
  const st = statuses.get(slot)?.status;
  if (!client) throw new Error('client not initialized');
  if (st !== 'READY') throw new Error(`slot not READY: ${st}`);
  return client;
}

async function sendTextBySlot(ws, slot, to, text) {
  const client = getClientReady(ws, slot);
  return client.sendMessage(to, text);
}

async function sendMediaBySlot(ws, slot, to, caption, attachments) {
  const client = getClientReady(ws, slot);
  for (let i = 0; i < attachments.length; i++) {
    const item = attachments[i];
    const buf = fs.readFileSync(item.path);
    const b64 = buf.toString('base64');
    const mime = item.type || 'application/octet-stream';
    const media = new MessageMedia(mime, b64, item.name);
    if (i === 0 && caption) await client.sendMessage(to, media, { caption });
    else await client.sendMessage(to, media);
  }
}

// admin / fallback（默认 A1 / A2，可 env 覆盖）
const ADMIN_SLOT = process.env.ADMIN_SLOT || 'A1';
const FALLBACK_SLOT = process.env.FALLBACK_SLOT || 'A2';

// ---------- 工具函数：获取浏览器页面对象 ----------
async function getPupPage(client) {
  const p =
    client?.pupPage ||
    client?._page ||
    client?.puppeteer?.page ||
    client?.page;

  if (!p) return null;
  return typeof p?.then === 'function' ? await p : p;
}

function extractInviteCode(link) {
  if (!link) return null;
  const text = String(link).trim();
  const match = text.match(
    /(?:https?:\/\/)?(?:chat\.whatsapp\.com|whatsapp\.com\/invite)\/([A-Za-z0-9]+)/i
  );
  return match ? match[1] : null;
}

function findGroupId(value, visited = new Set()) {
  if (!value) return null;
  if (typeof value === 'string') return value.endsWith('@g.us') ? value : null;
  if (typeof value !== 'object') return null;
  if (visited.has(value)) return null;
  visited.add(value);

  if (typeof value._serialized === 'string' && value._serialized.endsWith('@g.us')) {
    return value._serialized;
  }

  for (const key of Object.keys(value)) {
    const found = findGroupId(value[key], visited);
    if (found) return found;
  }
  return null;
}

function selectReadySlot(ws) {
  const { statuses } = ctx(ws);
  const adminStatus = statuses.get(ADMIN_SLOT)?.status;
  if (adminStatus === 'READY') return ADMIN_SLOT;

  const fallbackStatus = statuses.get(FALLBACK_SLOT)?.status;
  if (fallbackStatus === 'READY') return FALLBACK_SLOT;

  for (const [slot, st] of statuses.entries()) {
    if (st?.status === 'READY') return slot;
  }
  return null;
}

// slot -> 用 uid 建 LocalAuth（session-<uid>）
function ensureClient(ws, slot) {
  const { clients, statuses, profiles } = ctx(ws);
  if (clients.has(slot)) return clients.get(slot);
  if (!hasWorkerCapacity(ws)) {
    log('warn', 'worker_capacity_full', { ws, slot, active: getActiveCount(ws), max: MAX_ACTIVE });
    throw new Error('worker capacity full');
  }

  const acc = ensureAccount(ws, slot); // 确保 slot->uid 存在
  const uid = acc.uid;

  ensureWorkspace(ws);
  const authDir = getWorkspaceAuthDir(ws);
  fs.mkdirSync(authDir, { recursive: true });
  ensureSessionCompat(ws, acc.sessionDir || buildSessionDir(uid));

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: uid,
      dataPath: authDir
    }),
    puppeteer: {
      headless: false, // 如果你不想弹浏览器，把这里改 true
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
      ],
    },
  });

  client.__ws = ws;
  statuses.set(slot, { status: 'INIT', lastQr: null });

  client.on('qr', (qr) => {
    statuses.set(slot, { status: 'QR', lastQr: qr });
    emitWsEvent(ws, 'wa:qr', { slot, uid, qr });
    emitWsEvent(ws, 'wa:status', { slot, uid, status: 'QR' });
  });

  client.on('ready', () => {
    const phone =
      client?.info?.wid?.user ||
      client?.info?.me?.user ||
      null;

    const nickname =
      client?.info?.pushname ||
      client?.info?.pushName ||
      null;

    profiles.set(slot, { phone, nickname });

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

  clients.set(slot, client);
  return client;
}

// ---------- APIs ----------

migrateProjects();
cleanupTrash();
setInterval(() => cleanupTrash(), TRASH_CLEAN_INTERVAL_MS);

io.on('connection', (socket) => {
  const raw = socket.handshake.query?.ws || socket.handshake.headers?.['x-ws'] || 'default';
  const ws = resolveWs(Array.isArray(raw) ? raw[0] : raw);
  socket.join(ws);
});

// Projects CRUD
app.get('/api/projects', (req, res) => {
  try {
    const list = loadProjects().map(project => ({
      ...project,
      ...getCountsForWorkspace(project.id),
    }));
    return res.json({ ok: true, data: list });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });

    const list = loadProjects();
    const id = allocateProjectId();
    const now = nowIso();
    const project = { id, name, note, createdAt: now, updatedAt: now };
    list.push(project);
    saveProjects(list);
    ensureWorkspaceDir(id);
    ensureWorkspace(id);
    return res.json({ ok: true, data: project });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const id = safeId(req.params.id);
    const project = loadProjects().find(item => item.id === id);
    if (!project) return res.status(404).json({ ok: false, error: 'project not found' });
    return res.json({ ok: true, data: project });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const id = safeId(req.params.id);
    const list = loadProjects();
    const idx = list.findIndex(item => item.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'project not found' });

    const name = req.body?.name != null ? String(req.body?.name || '').trim() : null;
    const note = req.body?.note != null ? String(req.body?.note || '').trim() : null;
    if (name !== null && !name) return res.status(400).json({ ok: false, error: 'name required' });

    const current = list[idx];
    const updated = {
      ...current,
      name: name !== null ? name : current.name,
      note: note !== null ? note : current.note,
      updatedAt: nowIso(),
    };
    list[idx] = updated;
    saveProjects(list);
    return res.json({ ok: true, data: updated });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    const id = safeId(req.params.id);
    const list = loadProjects();
    const idx = list.findIndex(item => item.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'project not found' });

    list.splice(idx, 1);
    saveProjects(list);

    safeMoveToTrash(getWorkspaceConfigDir(id), 'workspaces', `${id}_config`);
    safeMoveToTrash(getWorkspaceWorkDir(id), 'workspaces', `${id}_work`);
    return res.json({ ok: true, data: { id } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ✅ 新增账号（只建坑位，不会弹浏览器，不会 initialize）
// body 可选：{ slot: "A1" }；不传就自动生成下一个 A{n}
app.post('/api/accounts/create', (req, res) => {
  try {
    const ws = getWs(req);
    const file = getWorkspaceAccountsFile(ws);
    const enabled = req.body?.enabled !== false;
    const requestedSlot = normalizeSlot(req.body?.slot);
    let result = null;
    let invalid = false;

    withFileLockSync(getWorkspaceConfigFileLock(file), () => {
      const list = loadAccounts(ws);
      let slot = requestedSlot;
      if (!slot) slot = nextSlotLabel(list);
      if (!isValidSlot(slot)) {
        invalid = true;
        return;
      }

      const existed = list.find(x => x.slot === slot);
      if (existed) {
        result = existed;
        return;
      }

      const uid = allocateNextUid(list);
      const acc = { slot, uid, sessionDir: buildSessionDir(uid), createdAt: Date.now(), enabled };
      list.push(acc);
      writeJson(file, list);
      result = acc;
    });

    if (invalid) return res.status(400).json({ ok: false, error: 'slot format must be A1/A2/...' });
    return res.json({ ok: true, data: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 账号列表：动态 N（只返回 accounts.json 里真实存在的账号）
// 没创建坑位时返回 []
app.get('/api/accounts', (req, res) => {
  const ws = getWs(req);
  const { statuses, profiles } = ctx(ws);
  const list = listAccountsSorted(ws);
  res.json({
    ok: true,
    data: list.map(acc => {
      const slot = acc.slot;
      const st = statuses.get(slot) || { status: 'NEW', lastQr: null };
      const pf = profiles.get(slot) || { phone: null, nickname: null };
      return { slot, uid: acc.uid, enabled: acc.enabled !== false, ...st, ...pf };
    }),
  });
});

app.get('/api/accounts/:slot/status', (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ ok: false, error: 'slot empty' });
  if (!ensureSlotOwned(res, slot)) return;

  const acc = getAccountBySlot(ws, slot);
  const { statuses, profiles } = ctx(ws);
  const st = statuses.get(slot) || { status: 'NONE', lastQr: null };
  const pf = profiles.get(slot) || { phone: null, nickname: null };
  return res.json({
    ok: true,
    slot,
    enabled: acc?.enabled !== false,
    uid: acc?.uid || null,
    status: st?.status || 'NONE',
    lastQr: st?.lastQr ?? null,
    phone: pf?.phone ?? null,
    nickname: pf?.nickname ?? null,
  });
});

app.post('/api/accounts/:slot/enabled', async (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ ok: false, error: 'slot empty' });
  if (!ensureSlotOwned(res, slot)) return;

  const enabled = req.body?.enabled !== false;
  const file = getWorkspaceAccountsFile(ws);
  let uid = null;
  const found = withFileLockSync(getWorkspaceConfigFileLock(file), () => {
    const list = loadAccounts(ws);
    const idx = list.findIndex(item => item.slot === slot);
    if (idx < 0) return false;
    list[idx] = { ...list[idx], enabled };
    uid = list[idx]?.uid || null;
    writeJson(file, list);
    return true;
  });
  if (!found) return res.status(404).json({ ok: false, error: 'account not found' });
  if (!enabled) {
    await destroyClient(ws, slot);
    emitWsEvent(ws, 'wa:status', { slot, uid, status: 'DISCONNECTED' });
  }
  return res.json({ ok: true, slot, enabled });
});

function cpuAverage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { idle, total };
}

let cpuSnapshotPrev = cpuAverage();
let cpuLast = 0;
setInterval(() => {
  try {
    const now = cpuAverage();
    const idle = now.idle - cpuSnapshotPrev.idle;
    const total = now.total - cpuSnapshotPrev.total;
    cpuLast = total <= 0 ? 0 : Number(((1 - idle / total) * 100).toFixed(1));
    cpuSnapshotPrev = now;
  } catch {}
}, 1000).unref();

app.get('/api/system/cpu', (_req, res) => {
  return res.json({ ok: true, cpu: cpuLast });
});

app.get('/api/system/recentLogs', (_req, res) => {
  return res.json({ ok: true, logs: RECENT_LOGS });
});

app.get('/api/accounts/:slot/groups', async (req, res) => {
  try {
    const ws = getWs(req);
    const { clients, statuses } = ctx(ws);
    const slot = normalizeSlot(req.params.slot);
    if (!ensureSlotOwned(res, slot)) return;

    const client = clients.get(slot);
    const st = statuses.get(slot)?.status;

    if (!client) return res.status(400).json({ ok: false, error: 'client not initialized' });
    if (st !== 'READY') return res.status(400).json({ ok: false, error: `slot not READY: ${st}` });

    const chats = await client.getChats();
    const groups = (chats || [])
      .filter(c => c && c.isGroup && String(c?.id?._serialized || '').endsWith('@g.us'))
      .map(c => {
        const id = String(c.id._serialized);
        const name = String(c.name || c.formattedTitle || 'Group');
        return { id, name };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true }));

    return res.json({ ok: true, data: groups });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/groups', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const rows = loadGroups(ws);
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/groups', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const file = getWorkspaceGroupsFile(ws);
    const id = String(req.body?.id || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
    if (!/@g\.us$/.test(id)) return res.status(400).json({ ok: false, error: 'id must end with @g.us' });
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    const row = {
      id,
      name,
      note: req.body?.note ? String(req.body.note).trim() || undefined : undefined,
      enabled: req.body?.enabled !== false,
      link: req.body?.link ? String(req.body.link).trim() || undefined : undefined,
    };
    let next = null;
    const ok = withFileLockSync(getWorkspaceConfigFileLock(file), () => {
      const list = loadGroups(ws);
      if (list.some(item => String(item?.id || '') === id)) return false;
      list.unshift(row);
      writeJson(file, list);
      next = list;
      return true;
    });
    if (!ok) return res.status(409).json({ ok: false, error: 'group already exists' });
    return res.json({ ok: true, row, rows: next });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put('/api/groups/:id', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const currentId = String(req.params.id || '').trim();
    const file = getWorkspaceGroupsFile(ws);
    const nextId = req.body?.id == null ? currentId : String(req.body.id || '').trim();
    if (!nextId) return res.status(400).json({ ok: false, error: 'id is required' });
    if (!/@g\.us$/.test(nextId)) return res.status(400).json({ ok: false, error: 'id must end with @g.us' });
    let updated = null;
    let rows = null;
    const state = withFileLockSync(getWorkspaceConfigFileLock(file), () => {
      const list = loadGroups(ws);
      const idx = list.findIndex(item => String(item?.id || '') === currentId);
      if (idx < 0) return 'not_found';
      const name = req.body?.name == null ? String(list[idx]?.name || '') : String(req.body.name || '').trim();
      if (!name) return 'name_required';
      const duplicate = list.findIndex((item, i) => i !== idx && String(item?.id || '') === nextId);
      if (duplicate >= 0) return 'duplicate';
      updated = {
        ...list[idx],
        id: nextId,
        name,
        note: req.body?.note == null ? list[idx]?.note : (String(req.body.note || '').trim() || undefined),
        enabled: req.body?.enabled == null ? Boolean(list[idx]?.enabled) : Boolean(req.body.enabled),
        link: req.body?.link == null ? list[idx]?.link : (String(req.body.link || '').trim() || undefined),
      };
      list[idx] = updated;
      writeJson(file, list);
      rows = list;
      return 'ok';
    });
    if (state === 'not_found') return res.status(404).json({ ok: false, error: 'group not found' });
    if (state === 'name_required') return res.status(400).json({ ok: false, error: 'name is required' });
    if (state === 'duplicate') return res.status(409).json({ ok: false, error: 'group id already exists' });
    return res.json({ ok: true, row: updated, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/groups/batch', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ ok: false, error: 'rows must be an array' });

    const cleaned = [];
    const seen = new Set();
    for (const item of rows) {
      const id = String(item?.id || '').trim();
      const name = String(item?.name || '').trim();
      if (!id || !/@g\.us$/.test(id)) {
        return res.status(400).json({ ok: false, error: `invalid group id: ${id || '<empty>'}` });
      }
      if (!name) return res.status(400).json({ ok: false, error: `name is required for ${id}` });
      if (seen.has(id)) return res.status(400).json({ ok: false, error: `duplicate id in rows: ${id}` });
      seen.add(id);
      cleaned.push({
        id,
        name,
        note: item?.note ? String(item.note).trim() || undefined : undefined,
        enabled: item?.enabled !== false,
        link: item?.link ? String(item.link).trim() || undefined : undefined,
      });
    }

    const file = getWorkspaceGroupsFile(ws);
    withFileLockSync(getWorkspaceConfigFileLock(file), () => {
      writeJson(file, cleaned);
    });
    return res.json({ ok: true, rows: cleaned });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/roles', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const roles = loadRoles(ws);
    return res.json({ ok: true, roles });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/roles/batch', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const roles = Array.isArray(req.body?.roles) ? req.body.roles : null;
    if (!roles) return res.status(400).json({ ok: false, error: 'roles must be an array' });

    for (const role of roles) {
      const slot = normalizeSlot(role?.boundSlot);
      if (!slot) continue;
      const acc = getAccountBySlot(ws, slot);
      if (!acc) return res.status(400).json({ ok: false, error: `bound slot not found: ${slot}` });
      if (acc.enabled === false) return res.status(400).json({ ok: false, error: `bound slot disabled: ${slot}` });
    }

    const file = getWorkspaceRolesFile(ws);
    withFileLockSync(getWorkspaceConfigFileLock(file), () => {
      writeJson(file, roles);
    });
    return res.json({ ok: true, roles });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/history', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const limitRaw = Number(req.query?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), HISTORY_LIMIT) : 500;
    const all = loadHistory(ws);
    const rows = all.slice(-limit);
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/history/append', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const payload = req.body?.rows ?? req.body?.row ?? req.body;
    const items = Array.isArray(payload) ? payload : (payload ? [payload] : []);
    if (!items.length) return res.status(400).json({ ok: false, error: 'row(s) is required' });

    const current = loadHistory(ws);
    const next = [...current, ...items];
    saveHistory(ws, next);
    return res.json({ ok: true, added: items.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/history/patch', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    const id = String(req.body?.id || '').trim();
    const patch = req.body?.patch;
    if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
    if (!patch || typeof patch !== 'object') return res.status(400).json({ ok: false, error: 'patch object is required' });

    const list = loadHistory(ws);
    const idx = list.findIndex(item => String(item?.id || '') === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'history item not found' });

    const updated = { ...list[idx], ...patch };
    list[idx] = updated;
    saveHistory(ws, list);
    return res.json({ ok: true, row: updated });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/history/clear', (req, res) => {
  try {
    const ws = getWs(req);
    ensureWorkspace(ws);
    saveHistory(ws, []);
    return res.json({ ok: true, rows: [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 兼容：若你还在别处用 /api/accounts/profiles
app.get('/api/accounts/profiles', (req, res) => {
  const ws = getWs(req);
  const { profiles } = ctx(ws);
  const slots = String(req.query.slots || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const data = {};
  for (const slot of slots) {
    data[slot] = profiles.get(slot) || { phone: null, nickname: null };
  }
  res.json({ ok: true, data });
});

// 群邀请链接解析（优先 A1 READY，否则 A2 READY，否则任意 READY）
app.post('/api/groups/resolve', async (req, res) => {
  const ws = getWs(req);
  const { clients } = ctx(ws);
  const link = req.body?.link;
  const join = Boolean(req.body?.join);
  const code = extractInviteCode(link);

  if (!code) return res.status(400).json({ ok: false, error: '无效的邀请链接' });

  const slot = selectReadySlot(ws);
  if (!slot) return res.json({ ok: false, error: 'admin 未上线，请先扫码' });

  const client = clients.get(slot);
  if (!client) return res.status(500).json({ ok: false, error: 'client 未初始化' });

  try {
    const info = await client.getInviteInfo(code);
    const name = info?.name || info?.subject || info?.groupName || '';
    let id =
      info?.id ||
      info?.gid ||
      info?.groupId ||
      info?.id?._serialized ||
      info?.gid?._serialized ||
      info?._serialized ||
      null;

    if (typeof id === 'object' && id?._serialized) id = id._serialized;
    if (!id) id = findGroupId(info);

    if (!id && join) {
      try {
        const joined = await client.acceptInvite(code);
        if (typeof joined === 'string') id = joined;
        else if (joined?.id) id = joined.id;
        else if (joined?._serialized) id = joined._serialized;
      } catch {}
    }

    if (!id) return res.json({ ok: false, error: '解析不到 @g.us，请稍后同步群列表' });

    return res.json({ ok: true, data: { slot, id, name } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 连接/扫码：会 initialize（此时才会弹浏览器/出二维码）
// slot 必须先 create，也可以不先 create（这里会自动 ensureAccount）
app.post('/api/accounts/:slot/connect', async (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ ok: false, error: 'slot empty' });
  if (!ensureSlotOwned(res, slot)) return;

  return enqueueSlot(ws, slot, async () => {
    const { statuses } = ctx(ws);
    const force = req.query.force === '1' || req.body?.force === true;
    const st = statuses.get(slot)?.status;
    if (force || st === 'AUTH_FAILURE' || st === 'DISCONNECTED') {
      await destroyClient(ws, slot);
    }

    const acc = ensureAccount(ws, slot);
    if (acc.enabled === false) return res.status(400).json({ ok: false, error: 'account disabled' });
    if (!ctx(ws).clients.has(slot) && !hasWorkerCapacity(ws)) {
      log('warn', 'worker_capacity_full', { ws, slot, active: getActiveCount(ws), max: MAX_ACTIVE });
      return res.status(429).json({ ok: false, error: 'worker capacity full' });
    }

    try {
      await singleflight(ws, slot, async () => {
        await destroyClient(ws, slot);
        const client = ensureClient(ws, slot);

        await withInitLimit(async () => {
          await client.initialize();
        });

        const page = await getPupPage(client).catch(() => null);
        await restoreAndFocus(page);
      });
      res.json({ ok: true, data: acc });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('worker capacity full')) return res.status(429).json({ ok: false, error: 'worker capacity full' });
      res.status(500).json({ ok: false, error: msg });
    }
  }).catch((e) => {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  });
});

async function rebuildClientAndGetPage(ws, slot, reason = 'manual') {
  log('warn', 'rebuild_start', { ws, slot, reason });
  try {
    const acc = ensureAccount(ws, slot);
    if (acc.enabled === false) throw new Error('account disabled');
    await destroyClient(ws, slot);
    const client = ensureClient(ws, slot);
    await withInitLimit(async () => {
      await client.initialize();
    });
    const page = await getPupPage(client);
    log('info', 'rebuild_done', { ws, slot });
    return page;
  } catch (err) {
    log('error', 'rebuild_fail', { ws, slot, err: String(err?.message || err) });
    throw err;
  }
}

// 登出：不会删掉 slot->uid（以后可重复登录同一个坑位）
app.post('/api/accounts/:slot/logout', async (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.params.slot);
  if (!ensureSlotOwned(res, slot)) return;
  return enqueueSlot(ws, slot, async () => {
    const uid = getAccountBySlot(ws, slot)?.uid || null;
    const { clients } = ctx(ws);
    const client = clients.get(slot);

    try { await client?.logout?.(); } catch {}
    await destroyClient(ws, slot);

    const { statuses } = ctx(ws);
    statuses.set(slot, { status: 'LOGGED_OUT', lastQr: null });
    emitWsEvent(ws, 'wa:status', { slot, uid, status: 'LOGGED_OUT' });
    res.json({ ok: true });
  }).catch((e) => {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  });
});

app.post('/api/accounts/:slot/destroy', async (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ ok: false, error: 'slot empty' });
  if (!ensureSlotOwned(res, slot)) return;
  return enqueueSlot(ws, slot, async () => {
    await destroyClient(ws, slot);
    const uid = getAccountBySlot(ws, slot)?.uid || null;
    emitWsEvent(ws, 'wa:status', { slot, uid, status: 'DISCONNECTED' });
    return res.json({ ok: true });
  }).catch((e) => {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  });
});

app.post('/api/accounts/:slot/stop', async (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ ok: false, error: 'slot empty' });
  if (!ensureSlotOwned(res, slot)) return;
  return enqueueSlot(ws, slot, async () => {
    await destroyClient(ws, slot);
    return res.json({ ok: true });
  }).catch((e) => {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  });
});

// 打开窗口（前置浏览器窗口）
app.post('/api/accounts/:slot/open', async (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ ok: false, error: 'slot empty' });
  if (!ensureSlotOwned(res, slot)) return;

  return enqueueSlot(ws, slot, async () => {
    const acc = ensureAccount(ws, slot);
    if (acc.enabled === false) return res.status(400).json({ ok: false, error: 'account disabled' });

    const { clients } = ctx(ws);
    let client = clients.get(slot);
    let page = client ? await getPupPage(client) : null;

    if (!page) page = await rebuildClientAndGetPage(ws, slot, 'open_no_page');
    if (!page) return res.status(400).json({ ok: false, error: '当前版本无法获取页面对象（无法打开窗口）' });

    try {
      await restoreAndFocus(page);
    } catch (e) {
      if (!isDetachedErr(e)) throw e;
      log('warn', 'puppeteer_detached_retry', { ws, slot, err: String(e?.message || e) });
      page = await rebuildClientAndGetPage(ws, slot, 'detached_frame_open');
      if (!page) return res.status(400).json({ ok: false, error: '当前版本无法获取页面对象（无法打开窗口）' });
      await restoreAndFocus(page);
    }

    return res.json({ ok: true });
  }).catch((e) => {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  });
});

// 打开聊天（bringToFront + 跳到 phone 聊天页面）
// body: { phone: "9477xxxxxxx", text?: "hello" } 也兼容 { to, text }
app.post('/api/accounts/:slot/openChat', async (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.params.slot);
  if (!slot) return res.status(400).json({ ok: false, error: 'slot empty' });
  if (!ensureSlotOwned(res, slot)) return;

  return enqueueSlot(ws, slot, async () => {
    const { clients, statuses } = ctx(ws);
    const acc = ensureAccount(ws, slot);
    if (acc.enabled === false) return res.status(400).json({ ok: false, error: 'account disabled' });

    const st = statuses.get(slot)?.status;
    if (st !== 'READY') return res.status(400).json({ ok: false, error: `slot not READY: ${st}` });

    const phoneRaw = String(req.body?.phone ?? req.body?.to ?? '').trim();
    const text = String(req.body?.text ?? '').trim();

    const phone = phoneRaw.replace(/[^\d]/g, '');
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required (digits only)' });

    const url =
      'https://web.whatsapp.com/send?phone=' +
      encodeURIComponent(phone) +
      '&text=' +
      encodeURIComponent(text) +
      '&app_absent=0';

    let client = clients.get(slot);
    let page = client ? await getPupPage(client) : null;
    if (!page?.goto) page = await rebuildClientAndGetPage(ws, slot, 'openchat_no_page');
    if (!page?.goto) return res.status(400).json({ ok: false, error: 'cannot access browser page' });

    try {
      await restoreAndFocus(page);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      if (!isDetachedErr(e)) throw e;
      log('warn', 'puppeteer_detached_retry', { ws, slot, err: String(e?.message || e) });
      page = await rebuildClientAndGetPage(ws, slot, 'detached_frame_openchat');
      if (!page?.goto) return res.status(400).json({ ok: false, error: 'cannot access browser page' });
      await restoreAndFocus(page);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    return res.json({ ok: true, data: { slot, phone, url } });
  }).catch((e) => {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  });
});

async function deleteAccountHandler(req, res) {
  const ws = getWs(req);
  const { clients, statuses, profiles } = ctx(ws);
  const slot = normalizeSlot(req.params.slot);
  if (!ensureSlotOwned(res, slot)) return;

  try {
    // 1) 停掉运行中的 client
    const client = clients.get(slot);
    if (client) {
      try { await client.logout(); } catch {}
      try { await client.destroy(); } catch {}
      clients.delete(slot);
    }
    statuses.delete(slot);
    profiles.delete(slot);

    // 2) 删除账号记录
    const file = getWorkspaceAccountsFile(ws);
    const acc = withFileLockSync(getWorkspaceConfigFileLock(file), () => {
      const list = loadAccounts(ws);
      const idx = list.findIndex(x => normalizeSlot(x.slot) === slot);
      if (idx < 0) return null;
      const removed = list[idx];
      list.splice(idx, 1);
      writeJson(file, list);
      return removed;
    });
    if (!acc) return res.json({ ok: true });

    // 3) 账号会话目录仅按 accounts.json 里的精确 sessionDir 回收
    const sessionDir = String(acc.sessionDir || '').trim();
    if (sessionDir) {
      const abs = path.join(getWorkspaceAuthDir(ws), sessionDir);
      safeMoveToTrash(abs, 'sessions', `${ws}_${slot}`);
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// 删除账号（会删除 accounts.json 的记录 + 回收 LocalAuth 会话目录）
app.delete('/api/accounts/:slot', deleteAccountHandler);
app.post('/api/accounts/:slot/delete', deleteAccountHandler);

// 纯文本发送
app.post('/api/accounts/:slot/send', async (req, res) => {
  const ws = getWs(req);
  const { clients, statuses } = ctx(ws);
  const slot = normalizeSlot(req.params.slot);
  if (!ensureSlotOwned(res, slot)) return;
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ ok: false, error: 'to/text required' });

  const client = clients.get(slot);
  const st = statuses.get(slot)?.status;

  if (!client) return res.status(400).json({ ok: false, error: 'client not initialized' });
  if (st !== 'READY') return res.status(400).json({ ok: false, error: `slot not READY: ${st}` });

  try {
    const msg = await retryDetached(
      () => client.sendMessage(to, text),
      () => getPupPage(client),
      2,
    );
    res.json({ ok: true, id: msg?.id?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});


// 媒体发送
app.post('/api/accounts/:slot/sendMedia', upload.array('files', 10), async (req, res) => {
  try {
    const ws = getWs(req);
    const { clients, statuses } = ctx(ws);
    const slot = normalizeSlot(req.params.slot);
    if (!ensureSlotOwned(res, slot)) return;
    const client = clients.get(slot);
    const st = statuses.get(slot)?.status;

    if (!client) return res.status(400).json({ ok: false, error: 'client not found' });
    if (st !== 'READY') return res.status(400).json({ ok: false, error: `slot not READY: ${st}` });

    const to = String(req.body.to || '').trim();
    const caption = String(req.body.caption || '');

    const files = req.files || [];
    if (!to) return res.status(400).json({ ok: false, error: 'missing to' });
    if (!files.length) return res.status(400).json({ ok: false, error: 'no files' });

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const buf = fs.readFileSync(f.path);
      const b64 = buf.toString('base64');
      const mime = f.mimetype || 'application/octet-stream';
      const media = new MessageMedia(mime, b64, f.originalname);

      await retryDetached(
        () => (i === 0 && caption ? client.sendMessage(to, media, { caption }) : client.sendMessage(to, media)),
        () => getPupPage(client),
        2,
      );

      fs.unlinkSync(f.path);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/schedules', (req, res) => {
  const ws = getWs(req);
  const list = loadScheduledJobs(ws);
  const active = list.filter(job => job.status === 'pending' || job.status === 'running');
  res.json({ ok: true, data: active });
});

app.get('/api/schedules/history', (req, res) => {
  const ws = getWs(req);
  const list = loadScheduledHistory(ws);
  res.json({ ok: true, data: list });
});

app.post('/api/schedules', scheduleUpload.array('files', 10), (req, res) => {
  const ws = getWs(req);
  const slot = normalizeSlot(req.body?.slot);
  if (!slot) return res.status(400).json({ ok: false, error: 'slot required' });
  if (!ensureSlotOwned(res, slot)) return;
  const mode = String(req.body?.mode || '').trim();
  const text = String(req.body?.text || '');
  const roleName = String(req.body?.roleName || '').trim();
  const minutes = Number(req.body?.minutes || 0);
  const targetsRaw = req.body?.targets;

  if (!mode) return res.status(400).json({ ok: false, error: 'mode required' });
  if (!targetsRaw) return res.status(400).json({ ok: false, error: 'targets required' });
  if (!['enabled_groups', 'single_group', 'single_contact'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'mode invalid' });
  }

  let targets = [];
  try {
    targets = JSON.parse(targetsRaw);
  } catch {
    return res.status(400).json({ ok: false, error: 'targets invalid' });
  }

  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ ok: false, error: 'targets empty' });
  }
  targets = targets.map(item => String(item || '').trim()).filter(Boolean);
  if (!targets.length) {
    return res.status(400).json({ ok: false, error: 'targets empty' });
  }

  const runAtValue = Number(req.body?.runAt);
  const runAt = Number.isFinite(runAtValue)
    ? runAtValue
    : (Date.now() + Math.max(1, Math.min(1440, minutes || 1)) * 60 * 1000);
  const jobId = req.scheduleId || newId();
  const files = req.files || [];
  const workspaceDir = getWorkspaceDir(ws);
  const attachments = files.map(f => ({
    id: f.filename,
    name: f.originalname,
    type: f.mimetype,
    path: path.relative(workspaceDir, f.path)
  }));
  const hasContent = (text && text.trim().length > 0) || attachments.length > 0;
  if (!hasContent) {
    cleanupScheduledUploads(ws, jobId);
    return res.status(400).json({ ok: false, error: 'content empty' });
  }

  const job = {
    id: jobId,
    ws,
    runAt,
    slot,
    mode,
    targets,
    text,
    roleName,
    attachments,
    status: 'pending',
    createdAt: Date.now(),
  };

  const list = loadScheduledJobs(ws);
  saveScheduledJobs(ws, [job, ...list]);

  res.json({ ok: true, data: job });
});

app.post('/api/schedules/:id/cancel', (req, res) => {
  const ws = getWs(req);
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const removed = removeScheduledJob(ws, id);
  cleanupScheduledUploads(ws, id);

  if (!removed) return res.status(404).json({ ok: false, error: 'not found' });
  archiveScheduledJob(ws, { ...removed, status: 'cancelled', finishedAt: Date.now() });
  res.json({ ok: true });
});

async function executeScheduledJob(ws, job) {
  const targets = Array.isArray(job.targets) ? job.targets : [];
  const attachments = (job.attachments || []).map(att => ({
    ...att,
    path: path.join(getWorkspaceDir(ws), att.path || '')
  }));

  const hasContent = (job.text && String(job.text).trim().length > 0) || attachments.length > 0;
  const result = { total: targets.length, okCount: 0, failCount: 0, lastErr: null };

  if (!targets.length) {
    result.failCount = 1;
    result.lastErr = 'targets empty';
  } else if (!hasContent) {
    result.failCount = targets.length;
    result.lastErr = 'content empty';
  } else {
    const sendOne = async (to) => {
      try {
        if (attachments.length > 0) {
          await sendMediaBySlot(ws, job.slot, to, job.text || '', attachments);
        } else {
          await sendTextBySlot(ws, job.slot, to, job.text || '');
        }
        result.okCount += 1;
        return true;
      } catch (e) {
        result.failCount += 1;
        result.lastErr = String(e?.message || e);
        return false;
      }
    };

    if (job.mode === 'enabled_groups') {
      await runPool(targets, async (t) => sendOne(t), 4);
    } else {
      await sendOne(targets[0]);
    }
  }

  const status = result.failCount > 0 ? 'failed' : 'done';
  const finishedJob = {
    ...job,
    status,
    result,
    finishedAt: Date.now()
  };

  archiveScheduledJob(ws, finishedJob);
  removeScheduledJob(ws, job.id);
  cleanupScheduledUploads(ws, job.id);
}

async function runWarmup() {
  try {
    const base = path.join(CONFIG_ROOT, 'workspaces');
    if (!fs.existsSync(base)) return;
    const wsList = fs.readdirSync(base).filter((name) => {
      const full = path.join(base, name);
      return fs.existsSync(full) && fs.statSync(full).isDirectory();
    });

    for (const ws of wsList) {
      const roles = loadRoles(ws);
      const accounts = loadAccounts(ws);
      const enabledSlots = new Set(accounts.filter((a) => a?.enabled !== false).map((a) => normalizeSlot(a.slot)).filter(Boolean));
      const rawSlots = Array.from(new Set((roles || []).map((r) => normalizeSlot(r?.boundSlot)).filter(Boolean)));
      const inRangeSlots = rawSlots.filter((slot) => slotInWorkerRange(slot));
      const slots = inRangeSlots.sort((a, b) => slotToNumber(a) - slotToNumber(b));

      const capacity = Math.max(0, MAX_ACTIVE - getActiveCount(ws));
      if (capacity <= 0) {
        log('warn', 'warmup_capacity_full', { ws, active: getActiveCount(ws), maxActive: MAX_ACTIVE });
        continue;
      }
      const limit = Math.min(capacity, WARMUP_LIMIT, MAX_ACTIVE);
      const selected = slots.slice(0, limit);
      log('info', 'warmup_start', { ws, count: selected.length, slots: selected });
      let ok = 0;
      let fail = 0;

      for (const slot of selected) {
        if (!enabledSlots.has(slot)) {
          log('warn', 'warmup_skip_disabled', { ws, slot });
          continue;
        }
        if (!hasWorkerCapacity(ws) && !ctx(ws).clients.has(slot)) {
          log('warn', 'warmup_capacity_full', { ws, active: getActiveCount(ws), maxActive: MAX_ACTIVE });
          break;
        }
        try {
          await enqueueSlot(ws, slot, async () => {
            await singleflight(ws, slot, async () => {
              const client = ensureClient(ws, slot);
              await withInitLimit(async () => {
                await client.initialize();
              });
            });
          });
          ok += 1;
        } catch {
          fail += 1;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      log('info', 'warmup_done', { ws, ok, fail });
    }
  } catch (e) {
    log('warn', 'warmup_failed', { err: String(e?.message || e) });
  }
}

let scheduleTickRunning = false;
setInterval(async () => {
  if (scheduleTickRunning) return;
  scheduleTickRunning = true;
  try {
    const base = path.join(CONFIG_ROOT, 'workspaces');
    if (!fs.existsSync(base)) return;
    const wsList = fs.readdirSync(base).filter((name) => {
      const full = path.join(base, name);
      return fs.existsSync(full) && fs.statSync(full).isDirectory();
    });

    for (const ws of wsList) {
      const list = loadScheduledJobs(ws);
      const now = Date.now();
      const due = list.filter(job => job.status === 'pending' && job.runAt <= now);
      if (!due.length) continue;

      for (const job of due) {
        const currentList = loadScheduledJobs(ws);
        const currentJob = currentList.find(j => j.id === job.id);
        if (!currentJob) continue;
        const updated = { ...currentJob, status: 'running', startedAt: Date.now() };
        const next = currentList.map(j => (j.id === job.id ? updated : j));
        saveScheduledJobs(ws, next);
        await executeScheduledJob(ws, updated);
      }
    }
  } finally {
    scheduleTickRunning = false;
  }
}, 1000);

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => {
  log('info', 'server_listen', { url: `http://127.0.0.1:${PORT}` });
  if (IS_MASTER_MODE) {
    log('info', 'warmup_skipped_master_mode', { port: PORT, workspace: WORKSPACE_ID || null });
    return;
  }
  setTimeout(() => { runWarmup(); }, 0);
});
