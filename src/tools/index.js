// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// 统一导出所有工具模块，支持热重载

module.exports = [
  require("./ping"),
  require("./r-reset"),
  require("./hook-chatgpt"),
  require("./window-tools"),
  require("./cdp-tools"),
  require("./exec-js"),
  require("./clipboard-tools"),
  require("./exec-tools"),
  require("./file-tools"),
  require("./electron-inject-tools"),
  require("./system-tools"),
  require("./notify-tools"),
  require("./automation-tools"),
  require("./account-tools"),
  require("./device-tools"),
  require("./desktop-snapshot-tools"),
  require("./download-tools"),
  require("./ipc-bridge"),
  require("./hook-gemini"),
  require("./chrome-tools"),
  require("./tab-browser-tools"),
  require("./hub-team-tools"),
  require("./list-tools"),
];
