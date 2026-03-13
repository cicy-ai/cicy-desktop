const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronRPC", {
  invoke: (toolName, args) => ipcRenderer.invoke("rpc", toolName, args),
});
