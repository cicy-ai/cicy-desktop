// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const { ipcMain, BrowserWindow } = require("electron");
const { createWindow } = require("../utils/window-utils");
const log = require("electron-log");
const { z } = require("zod");

// Register ipcMain listener once
if (!global._cicyIpcBridge) {
  global._cicyIpcBridge = true;

  ipcMain.on("cicy-open-window", (event, data) => {
    const { url, title } = data || {};
    if (!url) return;
    log.info(`[IPC Bridge] open-window: ${url} ${title || ""}`);
    const win = createWindow({ url, background: true }, 0, true); // 渲染进程请求:后台开,不抢焦点
    if (title) win.setTitle(title);
  });

  log.info("[IPC Bridge] ipcMain listener registered");
}

module.exports = (registerTool) => {
  registerTool(
    "ipc_bridge_status",
    "Check IPC bridge status",
    z.object({}),
    async () => ({
      content: [{ type: "text", text: `IPC bridge active: ${!!global._cicyIpcBridge}` }],
    }),
    { tag: "System" }
  );
};
