// Spawn + manage the bundled cicy-code daemon as a side process of the
// Electron app. Lifecycle owned by src/main.js.
//
// Layout assumptions:
//   - Packaged: <App>/Contents/Resources/cicy-code/cicy-code (set in
//     package.json build.mac.extraResources / build.linux.extraResources)
//   - Dev:      <repo>/vendor/cicy-code/<platform>-<arch>/cicy-code
//     (populated by scripts/prepare-cicy-code-sidecar.js before `npm start`)
//
// Windows is not bundled — cicy-code only cross-compiles for darwin / linux
// because its tmux/pty layer is POSIX-only. start() returns null on Windows
// after logging a "use Docker" hint, and the rest of the app continues
// (it can still talk to an externally-running cicy-code at :8008).

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_PORT = Number(process.env.CICY_CODE_PORT || 8008);

function platformDir() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return null;
}
function archDir() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  return null;
}

function bundledBinaryPath() {
  const plat = platformDir();
  const arch = archDir();
  if (!plat || !arch) return null;
  // 1. User-installed via in-app installer (preferred — freshest version)
  try {
    const installer = require("./installer");
    const userBin = installer.userBinary();
    if (userBin && fs.existsSync(userBin)) return userBin;
  } catch {}
  // 2. Detect packaged via process.resourcesPath. In dev mode resourcesPath
  // points into electron's own .app, which doesn't contain our sidecar dir,
  // so fall through to the repo vendor/ path.
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "cicy-code", "cicy-code");
    if (fs.existsSync(packaged)) return packaged;
  }
  // 3. Dev mode — repo vendor dir
  return path.resolve(__dirname, "..", "..", "vendor", "cicy-code", `${plat}-${arch}`, "cicy-code");
}

function probeExisting(port = DEFAULT_PORT, timeoutMs = 500) {
  return new Promise(resolve => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs },
      res => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

let child = null;

async function start({ logPath, port = DEFAULT_PORT, force = false } = {}) {
  if (child && !force) return child;

  if (!force && await probeExisting(port)) {
    console.log(`[cicy-code-sidecar] existing instance on :${port}, reusing`);
    return null;
  }

  if (process.platform === "win32") {
    // Windows uses WSL2 to host the linux-amd64 binary. The wsl module owns
    // every wsl-touching command; here we just delegate.
    try {
      const wsl = require("./wsl");
      const status = await wsl.checkStatus();
      if (!status.installed || !status.hasDistro) {
        console.warn(`[cicy-code-sidecar] WSL not ready (${JSON.stringify(status)}) — homepage will guide install`);
        return null;
      }
      if (!(await wsl.userInstalled())) {
        console.warn("[cicy-code-sidecar] cicy-code not installed in WSL yet — homepage will trigger install");
        return null;
      }
      const r = await wsl.start({ port, force });
      // Treat WSL-internal pid as the child token so the outer code knows we're up.
      child = { wsl: true, pid: r.pid };
      console.log(`[cicy-code-sidecar] started inside WSL pid=${r.pid}`);
      return child;
    } catch (e) {
      console.warn(`[cicy-code-sidecar] WSL start failed: ${e.message}`);
      return null;
    }
  }

  const bin = bundledBinaryPath();
  if (!bin || !fs.existsSync(bin)) {
    console.warn(`[cicy-code-sidecar] no bundled binary at ${bin || "(unknown path)"} — did prepare:sidecar run?`);
    return null;
  }

  let stdio = ["ignore", "ignore", "ignore"];
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  }

  const env = { ...process.env, CICY_CODE_PORT: String(port) };
  child = spawn(bin, [], { stdio, detached: false, env });
  console.log(`[cicy-code-sidecar] spawned ${bin} pid=${child.pid} port=${port} log=${logPath || "(none)"}`);

  child.on("exit", (code, signal) => {
    console.log(`[cicy-code-sidecar] exited code=${code} signal=${signal}`);
    child = null;
  });
  return child;
}

async function stop({ timeoutMs = 5000 } = {}) {
  if (!child) return;
  const p = child;
  child = null;
  // WSL-launched: not a real ChildProcess, kill via wsl pkill instead.
  if (p && p.wsl) {
    try { await require("./wsl").stop(); } catch {}
    return;
  }
  try { p.kill("SIGTERM"); } catch {}
  const start = Date.now();
  while (p.exitCode === null && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (p.exitCode === null) {
    try { p.kill("SIGKILL"); } catch {}
  }
}

module.exports = { start, stop, probeExisting, bundledBinaryPath };
