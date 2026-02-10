// electron/preload.cjs
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ws", {
  openProjectWindow: (projectId) => ipcRenderer.invoke("ws:openProjectWindow", projectId),
});
