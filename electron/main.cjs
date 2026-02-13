// electron/main.cjs
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

let win = null;
let isQuitting = false;
let masterProc = null;
const projectWindows = new Map();

const WS_HOME = path.join(app.getPath("appData"), "@ws-manager");
app.setPath("userData", WS_HOME);
fs.mkdirSync(app.getPath("userData"), { recursive: true });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function safeKill(proc) {
  try {
    if (!proc || proc.exitCode !== null) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    proc.kill("SIGTERM");
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 1000);
  } catch {}
}

function getUiIndexPath() {
  const isDev = !app.isPackaged;
  const candidates = isDev
    ? [
        path.join(__dirname, "..", "wa-panel-ui", "dist", "index.html"),
        path.join(__dirname, "..", "wa-panel-ui", "index.html"),
      ]
    : [
        path.join(process.resourcesPath, "wa-panel-ui", "dist", "index.html"),
        path.join(process.resourcesPath, "app", "wa-panel-ui", "dist", "index.html"),
      ];

  return candidates.find((p) => fs.existsSync(p)) || null;
}

function isBackendDisabled() {
  return String(process.env.DISABLE_BACKEND_AUTOSTART || "").trim() === "1";
}

function waitForHealth({ host = "127.0.0.1", port = 3000, timeoutMs = 15000 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host, port, path: "/health", timeout: 1500 }, (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        if (ok) return resolve(true);
        if (Date.now() - start >= timeoutMs) return reject(new Error(`health returned ${res.statusCode}`));
        setTimeout(tick, 350);
      });

      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => {
        if (Date.now() - start >= timeoutMs) {
          reject(new Error("master not ready (timeout)"));
        } else {
          setTimeout(tick, 350);
        }
      });
    };
    tick();
  });
}

async function startBackend() {
  if (isBackendDisabled()) {
    console.log("[backend] autostart disabled by DISABLE_BACKEND_AUTOSTART=1");
    return;
  }

  const rootDir = path.join(app.getPath("appData"), "@ws-manager", "wa-gateway-data");
  const configDir = path.join(rootDir, "data");
  const workDir = path.join(rootDir, "work");
  fs.mkdirSync(configDir, { recursive: true });

  try {
    await waitForHealth({ port: 3000, timeoutMs: 1200 });
    console.log("[backend] reusing running master on :3000");
    return;
  } catch {}

  if (masterProc && masterProc.exitCode === null) return;

  const isDev = !app.isPackaged;
  const gatewayDir = isDev
    ? path.join(__dirname, "..", "wa-gateway")
    : path.join(process.resourcesPath, "wa-gateway");
  const entry = path.join(gatewayDir, "master.js");

  const out = fs.openSync(path.join(app.getPath("userData"), "master.out.log"), "a");
  const err = fs.openSync(path.join(app.getPath("userData"), "master.err.log"), "a");

  const env = {
    ...process.env,
    PORT_MASTER: "3000",
    PREWARM: "0",
    LOG_LEVEL: "info",
    DATA_DIR: rootDir,
    CONFIGDIR: configDir,
    WORKDIR: workDir,
    WORKER_POOL_SIZE: "60",
    ELECTRON_RUN_AS_NODE: "1",
  };

  masterProc = spawn(process.execPath, [entry], {
    cwd: gatewayDir,
    windowsHide: true,
    env,
    stdio: ["ignore", out, err],
  });

  masterProc.on("exit", (code) => console.log("[backend] master exited", code));
  masterProc.on("error", (e) => console.error("[backend] master spawn error", e));

  await waitForHealth({ port: 3000, timeoutMs: 15000 });
}

function createMainWindow() {
  const uiIndex = getUiIndexPath();

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  if (!uiIndex) {
    win.loadURL("data:text/plain;charset=utf-8,UI index.html not found");
    win.webContents.openDevTools();
    return;
  }

  win.loadFile(uiIndex);

  win.on("close", async (e) => {
    if (isQuitting) return;
    e.preventDefault();

    const result = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["退出", "取消"],
      defaultId: 1,
      cancelId: 1,
      title: "确认退出",
      message: "确定要退出 WAStack 吗？",
      detail: "退出后将停止 wa-gateway 后台服务。",
      noLink: true,
    });

    if (result.response === 0) {
      isQuitting = true;
      app.quit();
    }
  });

  win.on("closed", () => (win = null));
}

function openProjectWindow(projectId) {
  const uiIndex = getUiIndexPath();
  if (!uiIndex) return;

  const key = String(projectId || '').trim();
  const exists = projectWindows.get(key);
  if (exists && !exists.isDestroyed()) {
    if (exists.isMinimized()) exists.restore();
    exists.focus();
    return;
  }

  const child = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  projectWindows.set(key, child);
  child.on('closed', () => projectWindows.delete(key));
  child.loadFile(uiIndex, { hash: `/w/${key}/tasks` });
}

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (e) {
    console.error("[backend] failed to start", e);
  }

  createMainWindow();
});

ipcMain.handle("ws:openProjectWindow", async (_event, projectId) => {
  openProjectWindow(projectId);
  return true;
});

app.on("window-all-closed", () => {
  safeKill(masterProc);
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  safeKill(masterProc);
});
