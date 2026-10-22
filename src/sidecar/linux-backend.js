// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Windows 上 Docker-版 cicy-code 跑在哪:WSL2(老机器)还是 QEMU(新机器,不再用 WSL)。
//
// 规则:2026-10-21 起新机器走 QEMU、端口 8009;2026-10-22 用户定「所有的机器全部用 QEMU」——
// 新判定一律 qemu(不再看机器上有没有 WSL)。已经落盘的判定不自动改:老机器的 wsl 由人逐台迁
// (停 WSL 容器 → 改 linux-backend.json → 重启 desktop),避免一升级就整队断服。
// 判定结果写进 ~/cicy-ai/db/linux-backend.json。CICY_LINUX_BACKEND=wsl|qemu 可强制覆盖。
//
// 必须在 main.js 最早处 init():sidecar-ipc 等模块在 require 时就读 CICY_DOCKER_APP_PORT。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const FILE = path.join(os.homedir(), "cicy-ai", "db", "linux-backend.json");
const DISTRO = process.env.CICY_WSL_DISTRO || "cicy-code-wsl";
const QEMU_PORT = 8009;
let _backend = null;

// 老机器的证据:WSL 注册表里有我们的发行版,或者之前算过的 docker 状态说装过。只读,不碰 wsl.exe。
function hasWslInstall() {
  try {
    execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s", "/f", DISTRO, "/d", "/e"], { windowsHide: true, timeout: 8000, stdio: "ignore" });
    return true;
  } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), "cicy-ai", "db", "docker-status.json"), "utf8"));
    if (j && (j.installed || j.running) && Number(j.port || 8008) === 8008) return true;
  } catch {}
  return false;
}

function decide() {
  if (process.platform !== "win32") return "native";
  const forced = String(process.env.CICY_LINUX_BACKEND || "").toLowerCase();
  if (forced === "wsl" || forced === "qemu") return forced;
  try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); if (j && (j.backend === "wsl" || j.backend === "qemu")) return j.backend; } catch {}
  const b = "qemu";
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ backend: b, decidedAt: new Date().toISOString(), hadWsl: hasWslInstall() }, null, 2)); } catch {}
  return b;
}

function init() {
  if (_backend) return _backend;
  _backend = decide();
  if (_backend === "qemu" && !process.env.CICY_DOCKER_APP_PORT) process.env.CICY_DOCKER_APP_PORT = String(QEMU_PORT);
  if (_backend === "qemu" && !process.env.CICY_SIDECAR_PORT) process.env.CICY_SIDECAR_PORT = process.env.CICY_DOCKER_APP_PORT;
  return _backend;
}
function backend() { return _backend || init(); }

module.exports = { init, backend, QEMU_PORT, hasWslInstall };
