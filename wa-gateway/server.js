// wa-gateway/server.js  （整文件覆盖）

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const fs = require('fs');
const path = require('path');
const multer = require('multer');
// randomUUID 导入将在最后删除

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const upload = multer({
  dest: path.join(__dirname, '_uploads'),
  limits: { fileSize: 64 * 1024 * 1024 } // 64MB
});

// ---------- 持久化 ----------
const DATA_DIR = path.join(__dirname, 'data');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
// ① 新增一个计数文件常量
const UID_COUNTER_FILE = path.join(DATA_DIR, 'uid_counter.txt'); // 只记录最后一次使用的uid数字
const UID_START = 100001;

// ② 覆盖 ensureDataFiles()（让它创建 uid_counter.txt）
function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WORKSPACES_DIR)) fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_FILE)) fs.writeFileSync(PROJECTS_FILE, '[]', 'utf-8');

  // 从 100000 起步（下一次分配会变成 100001）
  if (!fs.existsSync(UID_COUNTER_FILE)) fs.writeFileSync(UID_COUNTER_FILE, String(UID_START - 1), 'utf-8');
}
ensureDataFiles();

// ===== JSON helpers (atomic) =====
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}
function safeId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}
function nowIso() { return new Date().toISOString(); }

function getWs(req) {
  const raw = req.query?.ws || req.headers['x-ws'] || 'default';
  const ws = safeId(raw);
  return ws || 'default';
}

function getWorkspaceDir(ws) {
  return path.join(WORKSPACES_DIR, ws);
}
function getWorkspaceAccountsFile(ws) {
  return path.join(getWorkspaceDir(ws), 'accounts.json');
}
function getWorkspaceGroupsFile(ws) {
  return path.join(getWorkspaceDir(ws), 'groups.json');
}
function getWorkspaceAuthDir(ws) {
  return path.join(getWorkspaceDir(ws), 'wwebjs_auth');
}
function ensureWorkspace(ws) {
  const dir = getWorkspaceDir(ws);
  fs.mkdirSync(dir, { recursive: true });
}

function loadProjects() {
  const data = readJson(PROJECTS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveProjects(list) {
  writeJson(PROJECTS_FILE, list);
}
function ensureWorkspaceDir(id) {
  fs.mkdirSync(path.join(WORKSPACES_DIR, id), { recursive: true });
}
function getCountsForWorkspace(id) {
  const accounts = readJson(path.join(WORKSPACES_DIR, id, 'accounts.json'), []);
  const groups = readJson(path.join(WORKSPACES_DIR, id, 'groups.json'), []);
  return {
    accountsCount: Array.isArray(accounts) ? accounts.length : 0,
    groupsCount: Array.isArray(groups) ? groups.length : 0,
  };
}
function generateProjectId(name, list) {
  const base = safeId(name) || 'project';
  const existing = new Set((list || []).map(item => item.id));
  let candidate = base;
  let i = 1;
  while (existing.has(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  return candidate;
}

function loadAccounts(ws) {
  const file = getWorkspaceAccountsFile(ws);
  const data = readJson(file, []);
  return Array.isArray(data) ? data : [];
}
function saveAccounts(ws, list) {
  const file = getWorkspaceAccountsFile(ws);
  writeJson(file, list);
}
function normalizeSlot(s) {
  return String(s || '').trim();
}
function isValidSlot(slot) {
  return /^A\d+$/i.test(String(slot || '').trim());
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

function ensureAccount(ws, slot) {
  slot = normalizeSlot(slot);
  if (!slot) throw new Error('slot empty');
  if (!isValidSlot(slot)) throw new Error('slot format must be A1/A2/...');

  ensureWorkspace(ws);
  const list = loadAccounts(ws);
  let acc = list.find(x => x.slot === slot);
  if (!acc) {
    // ④A) 改 ensureAccount(slot) 里新建账号时：把 randomUUID() 换成 allocateNextUid(list)
    const uid = allocateNextUid(list);
    acc = { slot, uid, createdAt: Date.now() };
    list.push(acc);
    saveAccounts(ws, list);
  }
  return acc;
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

// ---------- 运行态：按 ws 分桶 ----------
const contexts = new Map(); // ws -> { clients, statuses, profiles }
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

  const acc = ensureAccount(ws, slot); // 确保 slot->uid 存在
  const uid = acc.uid;

  ensureWorkspace(ws);
  const authDir = getWorkspaceAuthDir(ws);
  fs.mkdirSync(authDir, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: uid,      // ✅ 唯一身份
      dataPath: authDir   // ✅ 统一存到 data/workspaces/<ws>/wwebjs_auth
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
    io.to(ws).emit('wa:qr', { slot, uid, qr });
    io.to(ws).emit('wa:status', { slot, uid, status: 'QR' });
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
    io.to(ws).emit('wa:status', { slot, uid, status: 'READY', phone, nickname });
  });

  client.on('auth_failure', (msg) => {
    statuses.set(slot, { status: 'AUTH_FAILURE', lastQr: null });
    io.to(ws).emit('wa:status', { slot, uid, status: 'AUTH_FAILURE', msg });
  });

  client.on('disconnected', (reason) => {
    statuses.set(slot, { status: 'DISCONNECTED', lastQr: null });
    io.to(ws).emit('wa:status', { slot, uid, status: 'DISCONNECTED', reason });
  });

  clients.set(slot, client);
  return client;
}

// ---------- APIs ----------

io.on('connection', (socket) => {
  const ws = safeId(socket.handshake.query?.ws) || 'default';
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
    const id = generateProjectId(name, list);
    const now = nowIso();
    const project = { id, name, note, createdAt: now, updatedAt: now };
    list.push(project);
    saveProjects(list);
    ensureWorkspaceDir(id);
    return res.json({ ok: true, data: { id } });
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

    const workspaceDir = path.join(WORKSPACES_DIR, id);
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
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
    const list = loadAccounts(ws);
    let slot = normalizeSlot(req.body?.slot);
    if (!slot) slot = nextSlotLabel(list);
    if (!isValidSlot(slot)) return res.status(400).json({ ok: false, error: 'slot format must be A1/A2/...' });

    const existed = list.find(x => x.slot === slot);
    if (existed) return res.json({ ok: true, data: existed });

    // ④B) /api/accounts/create 里新建账号时：把 randomUUID() 换成 allocateNextUid(list)
    const uid = allocateNextUid(list);
    const acc = { slot, uid, createdAt: Date.now() };
    list.push(acc);
    saveAccounts(ws, list);
    return res.json({ ok: true, data: acc });
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
      return { slot, uid: acc.uid, ...st, ...pf };
    }),
  });
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

  const acc = ensureAccount(ws, slot);
  const client = ensureClient(ws, slot);

  try {
    await client.initialize();
    res.json({ ok: true, data: acc });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 登出：不会删掉 slot->uid（以后可重复登录同一个坑位）
app.post('/api/accounts/:slot/logout', async (req, res) => {
  const ws = getWs(req);
  const { clients, profiles, statuses } = ctx(ws);
  const slot = normalizeSlot(req.params.slot);
  const client = clients.get(slot);
  if (!client) return res.json({ ok: true });

  const uid = getAccountBySlot(ws, slot)?.uid || null;

  try { await client.logout(); } catch {}
  try { await client.destroy(); } catch {}

  clients.delete(slot);
  profiles.delete(slot);
  statuses.set(slot, { status: 'LOGGED_OUT', lastQr: null });
  io.to(ws).emit('wa:status', { slot, uid, status: 'LOGGED_OUT' });
  res.json({ ok: true });
});

// 打开窗口（前置浏览器窗口）
app.post('/api/accounts/:slot/open', async (req, res) => {
  const ws = getWs(req);
  const { clients } = ctx(ws);
  const { slot } = req.params;
  const client = clients.get(slot);
  if (!client) return res.status(400).json({ ok: false, error: 'client not initialized' });

  const page = await getPupPage(client);
  if (page?.bringToFront) {
    try { await page.bringToFront(); } catch {}
    return res.json({ ok: true });
  }
  return res.status(400).json({ ok: false, error: '当前版本无法获取页面对象（无法打开窗口）' });
});

// 打开聊天（bringToFront + 跳到 phone 聊天页面）
// body: { phone: "9477xxxxxxx", text?: "hello" } 也兼容 { to, text }
app.post('/api/accounts/:slot/openChat', async (req, res) => {
  const ws = getWs(req);
  const { clients, statuses } = ctx(ws);

  const slot = normalizeSlot(req.params.slot);
  const client = clients.get(slot);
  if (!client) return res.status(400).json({ ok: false, error: 'client not initialized' });

  const st = statuses.get(slot)?.status;
  if (st !== 'READY') return res.status(400).json({ ok: false, error: `slot not READY: ${st}` });

  const phoneRaw = String(req.body?.phone ?? req.body?.to ?? '').trim();
  const text = String(req.body?.text ?? '').trim();

  const phone = phoneRaw.replace(/[^\d]/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'phone required (digits only)' });

  try {
    const page = await getPupPage(client);
    if (!page?.goto) return res.status(400).json({ ok: false, error: 'cannot access browser page' });

    const url =
      'https://web.whatsapp.com/send?phone=' +
      encodeURIComponent(phone) +
      '&text=' +
      encodeURIComponent(text) +
      '&app_absent=0';

    try { await page.bringToFront?.(); } catch {}
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    return res.json({ ok: true, data: { slot, phone, url } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 删除账号（会删除 accounts.json 的记录 + 删除 LocalAuth 缓存目录）
app.post('/api/accounts/:slot/delete', async (req, res) => {
  const ws = getWs(req);
  const { clients, statuses, profiles } = ctx(ws);
  const { slot } = req.params;

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
    const list = loadAccounts(ws);
    const idx = list.findIndex(x => x.slot === slot);
    if (idx < 0) return res.json({ ok: true });

    const acc = list[idx];
    list.splice(idx, 1);
    saveAccounts(ws, list);

    // 3) 删除 LocalAuth 会话目录（clientId = uid 时：session-<uid>）
    const uid = String(acc.uid || '').trim();
    if (uid) {
      const dir = path.join(getWorkspaceAuthDir(ws), `session-${uid}`);
      try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 纯文本发送
app.post('/api/accounts/:slot/send', async (req, res) => {
  const ws = getWs(req);
  const { clients, statuses } = ctx(ws);
  const slot = normalizeSlot(req.params.slot);
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ ok: false, error: 'to/text required' });

  const client = clients.get(slot);
  const st = statuses.get(slot)?.status;

  if (!client) return res.status(400).json({ ok: false, error: 'client not initialized' });
  if (st !== 'READY') return res.status(400).json({ ok: false, error: `slot not READY: ${st}` });

  try {
    const msg = await client.sendMessage(to, text);
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

      if (i === 0 && caption) await client.sendMessage(to, media, { caption });
      else await client.sendMessage(to, media);

      fs.unlinkSync(f.path);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

server.listen(3001, () => console.log('wa-gateway http://127.0.0.1:3001'));
