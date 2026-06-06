// Discover / probe / spawn the cicy-code daemon for the Electron app.
//
// Principle (2026-06): the daemon is run via `npx cicy-code` — a single
// source of truth. cicy-desktop neither bundles nor downloads a binary; the
// per-version binary is fetched from npm by the launcher (CN: npmmirror).
//   1. An already-running instance on :8008 (user-run, npx, surviving from a
//      previous launch). probeExisting wins → reuse, never double-spawn.
//   2. Otherwise spawn `npx cicy-code` on mac/linux.
//
// This replaced the old in-app installer (downloaded binary at
// ~/.local/bin/cicy-code), which raced the npx-launched daemon for :8008.
//
// Windows runs cicy-code in Docker (src/sidecar/docker.js); start() delegates
// there on win32. (The old WSL path was retired.)

const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

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

async function start({ logPath, port = DEFAULT_PORT, force = false, version = null } = {}) {
  if (child && !force) return child;

  if (!force && await probeExisting(port)) {
    console.log(`[cicy-code-sidecar] existing instance on :${port}, reusing`);
    return null;
  }

  if (process.platform === "win32") {
    // Windows runs cicy-code in Docker Desktop (the container's entrypoint
    // npx-installs cicy-code). The docker module owns image-load-from-R2 +
    // container run; here we just delegate. (Replaced the old WSL path.)
    try {
      const docker = require("./docker");
      const r = await docker.start({ port });
      if (!r) {
        console.warn("[cicy-code-sidecar] Docker not ready — homepage will guide install");
        return null;
      }
      child = r; // { docker:true, container, id }
      console.log(`[cicy-code-sidecar] started in Docker container ${r.container} (${r.id})`);
      return child;
    } catch (e) {
      console.warn(`[cicy-code-sidecar] Docker start failed: ${e.message}`);
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
  // version arg (e.g. "latest" from update()) wins over the env pin; explicit
  // `cicy-code@latest` makes npx re-resolve against the registry so an update
  // actually pulls a newer build even when an older one is cached/global.
  const pin = version || process.env.CICY_CODE_VERSION;
  const spec = pin ? `cicy-code@${pin}` : "cicy-code";
  child = spawn(npxBin, ["-y", spec], { stdio, detached: false, env });
  console.log(`[cicy-code-sidecar] spawned npx ${spec} pid=${child.pid} port=${port} registry=${registry} log=${logPath || "(none)"}`);

  child.on("exit", (code, signal) => {
    console.log(`[cicy-code-sidecar] exited code=${code} signal=${signal}`);
    child = null;
  });
  return child;
}

// PIDs currently LISTENing on `port`, via lsof. Tries a few common paths
// because the GUI-launched Electron process often has a minimal PATH. Returns
// [] when lsof is missing or nothing is listening.
const LSOF_CANDIDATES = ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"];
function listPortPids(port) {
  for (const bin of LSOF_CANDIDATES) {
    try {
      const out = execFileSync(bin, ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return [...new Set(out.split(/\s+/).map(s => parseInt(s, 10)).filter(n => n > 0))];
    } catch (e) {
      if (e && e.code === "ENOENT") continue; // wrong path → try next candidate
      return []; // lsof ran but matched nothing (non-zero exit)
    }
  }
  return [];
}

// Kill whatever is LISTENing on `port` — even a detached/orphan (PPID=1)
// cicy-code from a prior launch that we never tracked as a child. SIGTERM,
// wait for the port to free, then SIGKILL the stragglers.
async function killPortListeners(port = DEFAULT_PORT, timeoutMs = 5000) {
  const pids = listPortPids(port);
  if (!pids.length) return 0;
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!listPortPids(port).length) return pids.length;
    await new Promise(r => setTimeout(r, 150));
  }
  for (const pid of listPortPids(port)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  return pids.length;
}

async function stop({ timeoutMs = 5000, port = DEFAULT_PORT } = {}) {
  // 1) The child we spawned this session (npx) or the Docker container.
  if (child) {
    const p = child;
    child = null;
    if (p.docker) {
      try { await require("./docker").stop(); } catch {}
      return;
    }
    try { p.kill("SIGTERM"); } catch {}
    const t0 = Date.now();
    while (p.exitCode === null && Date.now() - t0 < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (p.exitCode === null) { try { p.kill("SIGKILL"); } catch {} }
  }

  // 2) Anything STILL on :port we didn't spawn — a detached npx from a prior
  //    launch, a user-run daemon, a PPID=1 orphan. The homepage 停止/重启 must
  //    act on the REAL listener; otherwise (no tracked child) it would no-op.
  //    Docker (win32) owns its own lifecycle, so skip the port-kill there.
  if (process.platform !== "win32") {
    await killPortListeners(port, timeoutMs);
  }
}

// Remove npx's cached cicy-code installs so the next spawn re-fetches from the
// registry. npx keys each temp install by a hash under ~/.npm/_npx; we only
// nuke entries that actually contain cicy-code (leaving other npx packages
// alone). Best-effort: missing dir / perms just yield 0 removed.
function clearNpxCache() {
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  let removed = 0;
  try {
    for (const ent of fs.readdirSync(npxRoot)) {
      const cc = path.join(npxRoot, ent, "node_modules", "cicy-code");
      if (fs.existsSync(cc)) {
        try {
          fs.rmSync(path.join(npxRoot, ent), { recursive: true, force: true });
          removed++;
        } catch {}
      }
    }
  } catch {}
  console.log(`[cicy-code-sidecar] cleared ${removed} npx cache entr${removed === 1 ? "y" : "ies"} for cicy-code`);
  return removed;
}

// Restart: stop the running daemon, let :8008 free, then force a fresh spawn
// (reusing the same cached version — no registry round-trip).
async function restart({ logPath, port = DEFAULT_PORT } = {}) {
  await stop({ port });
  await new Promise(r => setTimeout(r, 300));
  return start({ logPath, port, force: true });
}

// Update: stop, then start the LATEST build.
//   win32  → reload the Docker image (from R2) and re-run the container.
//   else   → clear the npx cache + spawn `cicy-code@latest` so npx re-resolves
//            against the registry (npmmirror for CN) and pulls a newer build.
async function update({ logPath, port = DEFAULT_PORT } = {}) {
  await stop({ port });
  if (process.platform === "win32") {
    try { await require("./docker").loadImage(); } catch (e) {
      console.warn(`[cicy-code-sidecar] docker image reload failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
    return start({ logPath, port, force: true });
  }
  clearNpxCache();
  await new Promise(r => setTimeout(r, 300));
  return start({ logPath, port, force: true, version: "latest" });
}

module.exports = { start, stop, restart, update, probeExisting, clearNpxCache };
