// Windows NATIVE sidecar backend: run cicy-code.exe directly — no Docker, no
// WSL. (2026-06 方向变更: the Docker route in docker.js is transitional and
// being retired; this module replaces it once stable.)
//
// The exe is a native Go build (w-10084's line). It shells out to a slim
// bundled MSYS2 (bash/tmux/coreutils…) which it locates itself via
// CICY_MSYS_ROOT probing — nothing to do here beyond optionally passing the
// env through. Known exe-side behaviors we rely on:
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

const EXE_URL = process.env.CICY_CODE_EXE_URL
  || "https://r2.deepfetch.de5.net/builds/cicy-code-win32-x64-dev.exe";
const BIN_DIR  = path.join(os.homedir(), "cicy-ai", "bin");
const EXE_PATH = process.env.CICY_CODE_EXE_PATH || path.join(BIN_DIR, "cicy-code.exe");
const PID_FILE = path.join(BIN_DIR, "cicy-code.pid");

const probeHealth = docker.probeHealth;

// Download (or reuse) the exe. ensureDownloaded HEAD-compares size → complete
// file is a no-op, partial resumes, retries with progress events.
async function ensureExe({ emit } = {}) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  await docker.ensureDownloaded(EXE_URL, EXE_PATH, null, {
    emit, phase: "exe", label: "下载 cicy-code.exe",
  });
  return EXE_PATH;
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
async function start({ port = 8008, logPath = null, emit } = {}) {
  if (await probeHealth(port)) {
    console.log(`[native-sidecar] :${port} already healthy — adopting`);
    return { native: true, adopted: true, port };
  }
  await ensureExe({ emit });
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
  const child = spawn(EXE_PATH, [], { stdio, detached: true, windowsHide: true, env });
  child.unref();
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch {}
  console.log(`[native-sidecar] spawned ${EXE_PATH} pid=${child.pid} port=${port} log=${logPath || "(none)"}`);

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

// Update = force re-download (unlink defeats ensureDownloaded's size-match
// skip) then restart on the new exe.
async function update({ port = 8008, logPath = null, emit } = {}) {
  await stop({ port });
  try { fs.unlinkSync(EXE_PATH); } catch {}
  return start({ port, logPath, emit });
}

async function checkStatus({ port = 8008 } = {}) {
  return {
    exePresent: fs.existsSync(EXE_PATH),
    running: await probeHealth(port),
    pid: readPid() || null,
  };
}

module.exports = { start, stop, restart, update, checkStatus, ensureExe, clearDockerLegacy, probeHealth, EXE_PATH };
