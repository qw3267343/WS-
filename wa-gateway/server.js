const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');


const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const fs = require('fs');
const path = require('path');
const multer = require('multer');

const upload = multer({
  dest: path.join(__dirname, '_uploads'),
  limits: { fileSize: 64 * 1024 * 1024 } // 64MB（你可调大/调小）
});

const clients = new Map();     // slot -> Client
const statuses = new Map();    // slot -> { status, lastQr }
const profiles = new Map(); // slot -> { pushname: string|null }

function ensureClient(slot) {
  if (clients.has(slot)) return clients.get(slot);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: slot }),
    puppeteer: {
      headless: false,
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

  statuses.set(slot, { status: 'INIT', lastQr: null });

  client.on('qr', (qr) => {
    statuses.set(slot, { status: 'QR', lastQr: qr });
    io.emit('wa:qr', { slot, qr });
    io.emit('wa:status', { slot, status: 'QR' });
  });

  client.on('ready', () => {
    const pushname =
      client?.info?.pushname ||
      client?.info?.wid?.user ||
      client?.info?.me?.user ||
      null;

    profiles.set(slot, { pushname });

    statuses.set(slot, { status: 'READY', lastQr: null });
    io.emit('wa:status', { slot, status: 'READY', pushname });
  });

  client.on('auth_failure', (msg) => {
    statuses.set(slot, { status: 'AUTH_FAILURE', lastQr: null });
    io.emit('wa:status', { slot, status: 'AUTH_FAILURE', msg });
  });

  client.on('disconnected', (reason) => {
    statuses.set(slot, { status: 'DISCONNECTED', lastQr: null });
    io.emit('wa:status', { slot, status: 'DISCONNECTED', reason });
  });

  clients.set(slot, client);
  return client;
}

app.get('/api/accounts/profiles', (req, res) => {
  const slots = String(req.query.slots || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const data = {};
  for (const slot of slots) {
    data[slot] = profiles.get(slot) || { pushname: null };
  }

  res.json({ ok: true, data });
});

app.get('/api/accounts', (req, res) => {
  const slots = req.query.slots ? String(req.query.slots).split(',').map(s=>s.trim()) : ['acc001'];
  res.json({
    ok: true,
    data: slots.map(slot => ({ slot, ...(statuses.get(slot) || { status: 'NEW', lastQr: null }) })),
  });
});

app.post('/api/accounts/:slot/connect', async (req, res) => {
  const { slot } = req.params;
  const client = ensureClient(slot);
  try {
    await client.initialize();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/accounts/:slot/logout', async (req, res) => {
  const { slot } = req.params;
  const client = clients.get(slot);
  if (!client) return res.json({ ok: true });

  try { await client.logout(); } catch {}
  try { await client.destroy(); } catch {}

  clients.delete(slot);
  statuses.set(slot, { status: 'LOGGED_OUT', lastQr: null });
  io.emit('wa:status', { slot, status: 'LOGGED_OUT' });
  res.json({ ok: true });
});

app.post('/api/accounts/:slot/send', async (req, res) => {
  const { slot } = req.params;
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ ok: false, error: 'to/text required' });

  const client = clients.get(slot);
  if (!client) return res.status(400).json({ ok: false, error: 'client not initialized' });

  try {
    const msg = await client.sendMessage(to, text);
    res.json({ ok: true, id: msg?.id?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

server.listen(3001, () => console.log('wa-gateway http://127.0.0.1:3001'));

app.post('/api/accounts/:slot/sendMedia', upload.array('files', 10), async (req, res) => {
  try {
    const slot = req.params.slot;
    const client = clients.get(slot);
    const st = statuses.get(slot)?.status;

    if (!client) return res.status(400).json({ ok: false, error: 'client not found' });
    if (st !== 'READY') return res.status(400).json({ ok: false, error: `slot not READY: ${st}` });

    const to = String(req.body.to || '').trim();
    const caption = String(req.body.caption || '');

    const files = req.files || [];
    if (!to) return res.status(400).json({ ok: false, error: 'missing to' });
    if (!files.length) return res.status(400).json({ ok: false, error: 'no files' });

    // 逐个发送：第一个带 caption，后面不带（避免重复文字）
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const buf = fs.readFileSync(f.path);
      const b64 = buf.toString('base64');
      const mime = f.mimetype || 'application/octet-stream';
      const media = new MessageMedia(mime, b64, f.originalname);

      if (i === 0 && caption) {
        await client.sendMessage(to, media, { caption });
      } else {
        await client.sendMessage(to, media);
      }

      // 删除临时文件
      fs.unlinkSync(f.path);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
