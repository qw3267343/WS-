// electron/main.cjs
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

let win = null;
let isQuitting = false;
let masterProc = null;  // 改为 master 进程

// ✅ 统一数据目录到 Roaming\@ws-manager（你想要的方案）
const WS_HOME = path.join(app.getPath("appData"), "@ws-manager");
app.setPath("userData", WS_HOME);
fs.mkdirSync(app.getPath("userData"), { recursive: true });

// ✅ 单实例，避免误点多开
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
    if (!proc) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    } else {
      proc.kill("SIGKILL");
    }
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

// ✅ 修改：启动 master.js 而非 server.js，强制使用 AppData
function startMaster() {
  // 防重复启动
  if (masterProc && masterProc.exitCode === null) return;

  const isDev = !app.isPackaged;

  const gatewayDir = isDev
    ? path.join(__dirname, "..", "wa-gateway")
    : path.join(process.resourcesPath, "wa-gateway");

  const entry = path.join(gatewayDir, "master.js");  // 改为 master.js

  // 运行数据目录：统一放在 userData 下
  const rootDir = path.join(app.getPath("userData"), "wa-gateway-data");
  fs.mkdirSync(rootDir, { recursive: true });
  const configDir = path.join(rootDir, "data");
  const workDir = path.join(rootDir, "work");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  // 日志文件
  const logDir = app.getPath("userData");
  const out = fs.openSync(path.join(logDir, "master.out.log"), "a");
  const err = fs.openSync(path.join(logDir, "master.err.log"), "a");

  // 构建环境变量
  const env = {
    ...process.env,
    PORT_MASTER: "3000",
    PREWARM: "2",
    LOG_LEVEL: "info",
    CONFIGDIR: configDir,
    SHARDS_JSON: JSON.stringify([
      { id: 1, port: 3001, from: "A1", to: "A30", workdir: path.join(workDir, "w1") },
      { id: 2, port: 3002, from: "A31", to: "A60", workdir: path.join(workDir, "w2") },
    ]),
    // 让 Electron 以 Node 模式运行脚本（避免弹出新窗口）
    ELECTRON_RUN_AS_NODE: "1",
  };

  console.log("[master] entry=", entry);
  console.log("[master] CONFIGDIR=", configDir);
  console.log("[master] workDir=", workDir);

  // 使用 process.execPath 启动（Electron 自带的 Node）
  masterProc = spawn(process.execPath, [entry], {
    cwd: gatewayDir,
    windowsHide: true,
    env,
    stdio: ["ignore", out, err],
  });

  masterProc.on("exit", (code) => console.log("[master] exited", code));
  masterProc.on("error", (e) => console.error("[master] spawn error", e));
}

// ✅ 修改默认端口为 3000（master 的端口）
function waitForMaster({ host = "127.0.0.1", port = 3000, timeoutMs = 20000 } = {}) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host, port, path: "/health", timeout: 1500 },
        (res) => {
          // 只要能连上并返回（200/404都行），基本说明服务已起来
          res.resume();
          resolve(true);
        }
      );

      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => {
        if (Date.now() - start >= timeoutMs) {
          reject(new Error("master not ready (timeout)"));
        } else {
          setTimeout(tick, 400);
        }
      });
    };

    tick();
  });
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

  // 调试用
  // win.webContents.openDevTools();

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

  const child = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // ✅ HashRouter：用 loadFile 的 hash 选项跳转到 #/w/:id/tasks
  child.loadFile(uiIndex, { hash: `/w/${projectId}/tasks` });

  // 调试用
  // child.webContents.openDevTools();
}

app.whenReady().then(async () => {
  startMaster();  // 启动 master

  try {
    await waitForMaster({ port: 3000, timeoutMs: 20000 });  // 等待 master 就绪
  } catch (e) {
    console.error("[master] not ready:", e);
    // 不中断启动：UI 依然打开，前端会自动重试
  }

  createMainWindow();
});

// ✅ 前端请求打开新窗口
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