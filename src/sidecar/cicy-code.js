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
  // Detect packaged via process.resourcesPath. In dev mode resourcesPath
  // points into electron's own .app, which doesn't contain our sidecar dir,
  // so fall through to the repo vendor/ path.
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "cicy-code", "cicy-code");
    if (fs.existsSync(packaged)) return packaged;
  }
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

async function start({ logPath, port = DEFAULT_PORT } = {}) {
  if (child) return child;

  if (await probeExisting(port)) {
    console.log(`[cicy-code-sidecar] existing instance on :${port}, reusing`);
    return null;
  }

  if (process.platform === "win32") {
    console.warn("[cicy-code-sidecar] Windows is not supported — run cicy-code in Docker, then point this app at it");
    return null;
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
