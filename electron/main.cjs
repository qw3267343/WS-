// electron/main.cjs
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

let win = null;
let isQuitting = false;
let gatewayProc = null;

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

function startGateway() {
  // 防重复启动
  if (gatewayProc && gatewayProc.exitCode === null) return;

  const isDev = !app.isPackaged;

  const gatewayDir = isDev
    ? path.join(__dirname, "..", "wa-gateway")
    : path.join(process.resourcesPath, "wa-gateway");

  const entry = path.join(gatewayDir, "server.js");

  // 运行数据目录：统一放在 userData 下
  const dataDir = path.join(app.getPath("userData"), "wa-gateway-data");
  fs.mkdirSync(dataDir, { recursive: true });

  // ✅ 关键：打包后用内置 node.exe 跑 server.js（用户无需安装 Node）
  // 开发环境：优先 WASTACK_NODE，其次系统 node
  // 打包环境：固定使用 resources/vendor/node/node.exe
  const nodePath = isDev
    ? (process.env.WASTACK_NODE || "node")
    : path.join(process.resourcesPath, "vendor", "node", "node.exe");

  // ✅ 打包后看日志（非常重要）
  const logDir = app.getPath("userData");
  const out = fs.openSync(path.join(logDir, "gateway.out.log"), "a");
  const err = fs.openSync(path.join(logDir, "gateway.err.log"), "a");

  console.log("[gateway] nodePath=", nodePath);
  console.log("[gateway] gatewayDir=", gatewayDir);
  console.log("[gateway] entry=", entry);
  console.log("[gateway] DATA_DIR=", dataDir);

  gatewayProc = spawn(nodePath, [entry], {
    cwd: gatewayDir,
    windowsHide: true,
    env: { ...process.env, PORT: "3001", DATA_DIR: dataDir },
    stdio: ["ignore", out, err],
  });

  gatewayProc.on("exit", (code) => console.log("[gateway] exited", code));
  gatewayProc.on("error", (e) => console.error("[gateway] spawn error", e));
}

function waitForGateway({ host = "127.0.0.1", port = 3001, timeoutMs = 20000 } = {}) {
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
          reject(new Error("gateway not ready (timeout)"));
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
  startGateway();

  try {
    await waitForGateway({ port: 3001, timeoutMs: 20000 });
  } catch (e) {
    console.error("[gateway] not ready:", e);
    // 不中断启动：UI 依然打开，前端会自动重试（方案1兜底）
  }

  createMainWindow();
});


// ✅ 前端请求打开新窗口
ipcMain.handle("ws:openProjectWindow", async (_event, projectId) => {
  openProjectWindow(projectId);
  return true;
});

app.on("window-all-closed", () => {
  safeKill(gatewayProc);
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  safeKill(gatewayProc);
});

