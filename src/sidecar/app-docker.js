// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Docker-版 cicy-code 的运行层(同接口):darwin → Colima,win32 → WSL2(老机器)或 QEMU(新机器)。
// 选哪个见 linux-backend.js。调用方一律经这里拿,别再直接 require("./wsl-docker")。
const backend = require("./linux-backend").backend();
module.exports = process.platform === "darwin" ? require("./colima-docker")
  : backend === "qemu" ? require("./qemu-docker")
  : require("./wsl-docker");
