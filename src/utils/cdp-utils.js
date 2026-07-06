// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

async function sendCDP(webContents, method, params = {}) {
  if (!webContents.debugger.isAttached()) {
    webContents.debugger.attach("1.3");
  }
  return await webContents.debugger.sendCommand(method, params);
}

module.exports = { sendCDP };
