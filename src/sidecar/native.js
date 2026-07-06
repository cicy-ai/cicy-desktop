// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Windows NATIVE sidecar backend: run cicy-code.exe directly — no Docker, no
// WSL. (2026-06 方向变更: the Docker route in docker.js is transitional and
// being retired; this module replaces it once stable.)
//
// The exe is a native Go build (w-10084's line). Known exe-side behaviors we
// rely on:
//   - reads PORT / CICY_CODE_PORT for the listen port
//   - missing optional deps degrade to warnings (never os.Exit)
//   - cold tmux-server start may need ConPTY (w-10084's ensureTmuxServer, WIP)
//
// Gate: cicy-code.js picks this module over docker.js when
// CICY_WIN_NATIVE === "1" (dev flag until the native route ships by default).
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const docker = require("./docker"); // ensureDownloaded/withRetry/waitUntil/probeHealth/run

// Exe acquisition (2026-06-07): the PRODUCT path is npm — the
// cicy-code-win32-x64 subpackage (optionalDependency of cicy-code, os/cpu
// pinned) carries cicy-code.exe, installed via npmmirror with npm's own
// caching/resume/version management. NO R2 download in product. The R2
// direct-pull below survives ONLY for w-10084↔w-10026 联调, gated on an
// explicitly set CICY_CODE_EXE_URL.
// dev/联调 only — read LAZILY (not at require time) so tests/tools can set the
// env var after loading the module.
const devExeUrl = () => process.env.CICY_CODE_EXE_URL || "";
const EXE_PKG  = process.env.CICY_CODE_EXE_PKG || "cicy-code-windows-x64"; // npm spam filter 403s 'win32' names
const REGISTRY = process.env.CICY_NPM_REGISTRY || "https://registry.npmmirror.com";
const BIN_DIR  = path.join(os.homedir(), "cicy-ai", "bin");
// npm prefix dir owned by the sidecar (isolated from the user's global npm).
const NPM_PREFIX = path.join(os.homedir(), "cicy-ai", "sidecar-npm");
const DEV_EXE_PATH = process.env.CICY_CODE_EXE_PATH || path.join(BIN_DIR, "cicy-code.exe");
const PID_FILE = path.join(BIN_DIR, "cicy-code.pid");

function npmExePath() {
  return path.join(NPM_PREFIX, "node_modules", EXE_PKG, "cicy-code.exe");
}

const probeHealth = docker.probeHealth;

// Acquire (or reuse) the exe.
//   PRODUCT: npm-install the win32 subpackage into the sidecar's own prefix
//   and resolve the exe inside it — npm brings caching/integrity/versioning,
//   npmmirror keeps CN viable. `version` ("latest" from update()) re-resolves.
//   DEV (联调 only): CICY_CODE_EXE_URL set → resumable R2 download.
async function ensureExe({ emit, version = null } = {}) {
  if (devExeUrl()) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    await docker.ensureDownloaded(devExeUrl(), DEV_EXE_PATH, null, {
      emit, phase: "exe", label: "下载 cicy-code.exe (dev)",
    });
    return DEV_EXE_PATH;
  }
  const exe = npmExePath();
  if (!version && fs.existsSync(exe)) return exe;
  const e = emit || (() => {});
  e({ phase: "exe", status: "running", message: "npm 安装 cicy-code (win32)…" });
  fs.mkdirSync(NPM_PREFIX, { recursive: true });
  const spec = `${EXE_PKG}@${version || "latest"}`;
  // npm on Windows is npm.cmd — Node ≥18 (CVE-2024-27980) refuses to spawn
  // .cmd/.bat without shell:true (spawn EINVAL). shell:true concatenates args
  // un-escaped, so quote the one arg that can contain spaces (user dir).
  const quotedPrefix = /\s/.test(NPM_PREFIX) ? `"${NPM_PREFIX}"` : NPM_PREFIX;
  await new Promise((resolve, reject) => {
    execFile("npm", ["i", spec, "--prefix", quotedPrefix, `--registry=${REGISTRY}`, "--no-audit", "--no-fund", "--loglevel=error"],
      { windowsHide: true, timeout: 600000, shell: true },
      (err, _o, stderr) => err ? reject(new Error(`npm i ${spec}: ${String(stderr).slice(0, 200)}`)) : resolve());
  });
  if (!fs.existsSync(exe)) throw new Error(`installed ${spec} but ${exe} missing`);
  e({ phase: "exe", status: "done", message: "cicy-code.exe 就绪" });
  return exe;
}

// One-time migration off the Docker route: the legacy containers (`cicy` from
// the old flow, `cicy-code` from docker.js) hold :8008 and `--restart
// unless-stopped` revives them on every daemon start — rm -f BOTH or the port
// is never free. Best-effort: no Docker installed → nothing to clear.
async function clearDockerLegacy() {
  for (const name of ["cicy", "cicy-code"]) {
    try { await docker.run(["rm", "-f", name], { timeout: 20000 }); console.log(`[native-sidecar] removed legacy container ${name}`); }
    catch { /* absent or no docker — fine */ }
  }
}

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, "utf8").trim()) || 0; } catch { return 0; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// PIDs listening on :port via netstat (Windows has no lsof).
function listPortPids(port) {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve([]);
      const pids = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
          const pid = Number(line.trim().split(/\s+/).pop());
          if (pid) pids.add(pid);
        }
      }
      resolve([...pids]);
    });
  });
}

function taskkill(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/f", "/t", "/pid", String(pid)], { windowsHide: true, timeout: 15000 }, () => resolve());
  });
}

// Start cicy-code.exe on :port. Adopts an already-healthy instance. When
// taking the canonical :8008, clears the legacy Docker containers first so
// they can't fight for the bind.
async function start({ port = 8008, logPath = null, emit, version = null } = {}) {
  if (await probeHealth(port)) {
    console.log(`[native-sidecar] :${port} already healthy — adopting`);
    return { native: true, adopted: true, port };
  }
  const exe = await ensureExe({ emit, version });
  if (port === 8008) await clearDockerLegacy();

  let stdio = ["ignore", "ignore", "ignore"];
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  }
  const env = {
    ...process.env,
    PORT: String(port),
    CICY_CODE_PORT: String(port),
  };
  // --helper removed : boot cicy-code in normal mode (full tmux-based
  // multi-agent), not the single headless 团队助手.
  const child = spawn(exe, ["--desktop"], { stdio, detached: true, windowsHide: true, env });
  child.unref();
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch {}
  console.log(`[native-sidecar] spawned ${exe} --desktop pid=${child.pid} port=${port} log=${logPath || "(none)"}`);

  const up = await docker.waitUntil(() => probeHealth(port), { totalMs: 60000, everyMs: 2000 });
  if (!up) {
    console.warn(`[native-sidecar] :${port} not healthy after 60s (exe may still be warming up)`);
    return null;
  }
  return { native: true, pid: child.pid, port };
}

// Stop whatever serves :port — pidfile first, then netstat by port.
async function stop({ port = 8008 } = {}) {
  const pid = readPid();
  if (pidAlive(pid)) await taskkill(pid);
  for (const p of await listPortPids(port)) await taskkill(p);
  try { fs.unlinkSync(PID_FILE); } catch {}
}

async function restart({ port = 8008, logPath = null } = {}) {
  await stop({ port });
  await new Promise((r) => setTimeout(r, 1000));
  return start({ port, logPath });
}

// Update — SAFE swap order: acquire the new build FIRST (progress streamed),
// only then stop the running instance and switch. A dead network therefore
// fails the update loudly but never kills a working install. Dev route
// downloads to .new and renames; npm route re-resolves @latest in place
// (npm's own staging is already atomic).
async function update({ port = 8008, logPath = null, emit } = {}) {
  const e = emit || (() => {});
  if (devExeUrl()) {
    const tmp = DEV_EXE_PATH + ".new";
    try { fs.unlinkSync(tmp); } catch {}
    e({ phase: "download", status: "running", message: "下载新版 cicy-code.exe…", progress: 0 });
    await docker.ensureDownloaded(devExeUrl(), tmp, null, { emit, phase: "download", label: "下载新版" });
    if (!fs.existsSync(tmp)) throw new Error("下载未完成，保留当前版本");
    e({ phase: "swap", status: "running", message: "停止旧版本…" });
    await stop({ port });
    try { fs.unlinkSync(DEV_EXE_PATH + ".bak"); } catch {}
    try { fs.renameSync(DEV_EXE_PATH, DEV_EXE_PATH + ".bak"); } catch {}
    fs.renameSync(tmp, DEV_EXE_PATH);
  } else {
    e({ phase: "download", status: "running", message: "npm 获取最新版…" });
    await ensureExe({ emit, version: "latest" }); // service untouched until this succeeds
    e({ phase: "swap", status: "running", message: "重启服务…" });
    await stop({ port });
  }
  const r = await start({ port, logPath, emit });
  e({ phase: "done", status: r ? "done" : "error", message: r ? "已更新并重启" : "更新后启动失败" });
  return r;
}

async function checkStatus({ port = 8008 } = {}) {
  return {
    exePresent: fs.existsSync(devExeUrl() ? DEV_EXE_PATH : npmExePath()),
    running: await probeHealth(port),
    pid: readPid() || null,
  };
}

module.exports = { start, stop, restart, update, checkStatus, ensureExe, clearDockerLegacy, probeHealth, npmExePath };
