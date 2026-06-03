// Discover / probe / spawn the cicy-code daemon for the Electron app.
//
// Principle (2026-06): the daemon is run via `npx cicy-code` — a single
// source of truth. cicy-desktop neither bundles nor downloads a binary; the
// per-version binary is fetched from npm by the launcher (CN: npmmirror).
//   1. An already-running instance on :8008 (user-run, npx, surviving from a
//      previous launch). probeExisting wins → reuse, never double-spawn.
//   2. Otherwise spawn `npx cicy-code` on mac/linux.
//
// This replaced the old src/sidecar/installer.js binary (~/.local/bin/
// cicy-code), which raced the npx-launched daemon for :8008. The in-app
// installer is no longer the daemon source.
//
// Windows is WSL2-hosted via src/sidecar/wsl.js; start() delegates there on
// win32 (npx-in-WSL migration tracked separately).

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_PORT = Number(process.env.CICY_CODE_PORT || 8008);

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

  let stdio = ["ignore", "ignore", "ignore"];
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  }

  // Run the daemon via `npx cicy-code` — no bundled/downloaded binary. The
  // launcher fetches the per-version binary from npm (default npmmirror for
  // CN; override with CICY_NPM_REGISTRY) and does its own :8008 port hygiene.
  // cicy-code reads PORT; we also set CICY_CODE_PORT and override the parent's
  // PORT (the worker sets it to its own listen port, e.g. 8101) so it doesn't
  // leak in and clash with the worker's HTTP server.
  const registry = process.env.CICY_NPM_REGISTRY || "https://registry.npmmirror.com";
  const env = {
    ...process.env,
    CICY_CODE_PORT: String(port),
    PORT: String(port),
    npm_config_registry: registry,
  };
  const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
  const spec = process.env.CICY_CODE_VERSION
    ? `cicy-code@${process.env.CICY_CODE_VERSION}`
    : "cicy-code";
  child = spawn(npxBin, ["-y", spec], { stdio, detached: false, env });
  console.log(`[cicy-code-sidecar] spawned npx ${spec} pid=${child.pid} port=${port} registry=${registry} log=${logPath || "(none)"}`);

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

module.exports = { start, stop, probeExisting };
