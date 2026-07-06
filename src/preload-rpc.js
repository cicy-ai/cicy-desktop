// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronRPC", {
  invoke: (toolName, args) => ipcRenderer.invoke("rpc:guarded", toolName, args),
});
