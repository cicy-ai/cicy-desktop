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
const net = require("net");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const DEFAULT_PORT = Number(process.env.CICY_CODE_PORT || 8008);

// Liveness = "is something LISTENING on :port", via a raw TCP connect — NOT an
// HTTP GET. /health can block (mid-boot, busy, hung) and time out even while the
// daemon owns the socket; an HTTP-timeout probe then returns false and start()
// spawns a SECOND cicy-code that races the first for :8008 (the duplicate-spawn
// storm). A TCP connect succeeds the instant the socket is bound, so a present
// daemon is always reused, never double-spawned.
function probeExisting(port = DEFAULT_PORT, timeoutMs = 500) {
  return new Promise(resolve => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false)); // ECONNREFUSED → nothing there
  });
}

// Running-daemon version lives in ONE place now: require("./version").running().
// update() below uses it to verify what's actually live after a restart.

let child = null;

// Runtime Bundle v1 (主人指令): prefer the versioned runtime store on EVERY
// platform — first run seeds it from the bundled optionalDependency (zero
// network, zero npx), upgrades come through runtime.upgrade(). Returns the
// spawn child or null when the store has no usable binary (legacy fallbacks
// below take over).
async function startFromRuntime({ logPath, port }) {
  let runtime;
  try { runtime = require("./runtime"); } catch { return null; }
  let exe = null;
  try { exe = runtime.binPath("cicy-code") || runtime.ensureFromBundle("cicy-code"); } catch (e) {
    console.warn(`[cicy-code-sidecar] runtime store unusable: ${e.message}`);
  }
  // Bundle absent or empty (npm optionalDependencies are best-effort — a flaky
  // mirror/network can leave the dep recorded but unpopulated). Don't strand
  // the user: pull the pinned/latest version from npm into the runtime store.
  // This is the network fallback to the zero-network bundle seed.
  if (!exe) {
    try {
      const { latest } = await runtime.checkUpdate("cicy-code");
      if (latest) {
        console.log(`[cicy-code-sidecar] bundle missing — npm-pulling cicy-code@${latest} into runtime store`);
        await runtime.fetchVersion("cicy-code", latest);
        runtime.switchCurrent("cicy-code", latest);
        exe = runtime.binPath("cicy-code");
      }
    } catch (e) { console.warn(`[cicy-code-sidecar] runtime npm-pull failed: ${e.message}`); }
  }
  if (!exe) return null;

  let stdio = ["ignore", "ignore", "ignore"];
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  }
  const env = {
    ...process.env,
    CICY_CODE_PORT: String(port),
    PORT: String(port),
  };
  if (process.platform === "win32") {
    try {
      const msys = runtime.binPath("msys2") || runtime.ensureFromBundle("msys2");
      if (msys) env.CICY_MSYS_ROOT = msys; // w-10084 exe 探测约定
    } catch {}
  }
  const c = spawn(exe, ["--desktop"], { stdio, detached: false, windowsHide: true, env });
  console.log(`[cicy-code-sidecar] spawned runtime ${exe} --desktop (v${runtime.currentVersion("cicy-code")}) pid=${c.pid} port=${port}`);
  c.on("exit", (code, signal) => {
    console.log(`[cicy-code-sidecar] exited code=${code} signal=${signal}`);
    child = null;
  });
  return c;
}

async function start({ logPath, port = DEFAULT_PORT, force = false, version = null } = {}) {
  if (child && !force) return child;

  // macOS: DOCKER-ONLY (主人指令: native 退役). The native sidecar runs cicy-code
  // directly on the host → it can touch the user's real files with no isolation.
  // The container persists everything in a named docker volume instead, so user
  // data is isolated. Delegate to the docker sidecar: it adopts a healthy :8008,
  // else runs the cicy-code image with -p ${port}:8008 (Docker Desktop / colima
  // auto-forward -p to the Mac's localhost, so no --network host needed). Returns
  // null when docker isn't up yet → the homepage docker card guides the user.
  if (process.platform === "darwin") {
    try {
      const docker = require("./docker");
      const r = await docker.start({ port });
      if (r) console.log(`[cicy-code-sidecar] docker cicy-code on :${port} (${r.adopted ? "adopted" : r.id || "started"})`);
      else console.warn("[cicy-code-sidecar] docker not ready — homepage docker card will guide install");
    } catch (e) { console.warn(`[cicy-code-sidecar] docker start failed: ${e.message}`); }
    return null; // no native child on mac
  }

  if (!force && await probeExisting(port)) {
    console.log(`[cicy-code-sidecar] existing instance on :${port}, reusing`);
    return null;
  }

  // UNIFIED model (主人指令): run our OWN binary at ~/.local/bin/cicy-code on
  // every platform — never `npx cicy-code` (which reuses a stale globally-installed
  // copy and shadows updates). localbin seeds from the bundled subpackage on first
  // run (zero network) and uses npm ONLY as a download channel for updates; the run
  // path is always stable.
  const localbin = require("./localbin");
  let exe = localbin.currentLink();
  if (!exe) {
    try { exe = (await localbin.ensure({ version }))?.exe; }
    catch (e) { console.warn(`[cicy-code-sidecar] localbin ensure failed: ${e.message}`); }
  } else {
    // Present — let ensure() do a zero-network bundle upgrade if cicy-desktop
    // itself was updated and now ships a newer cicy-code (版本高了就更新).
    try { await localbin.ensure({ version }); } catch {}
  }
  if (!exe) { console.warn("[cicy-code-sidecar] no cicy-code binary available"); return null; }

  // cicy-desktop ALSO owns the mihomo binary (same npm/localbin model). Seed it
  // into ~/.local/bin/mihomo from the bundle (zero network) BEFORE the cicy-code
  // daemon boots, so cicy-code's own startup finds it already present and skips
  // its GitHub/COS download. Best-effort — never block cicy-code on it.
  try {
    const r = await localbin.ensure({ name: "mihomo" });
    if (r?.exe) console.log(`[cicy-code-sidecar] mihomo ready at ${r.exe} (v${r.version || "?"})`);
  } catch (e) { console.warn(`[cicy-code-sidecar] mihomo seed skipped: ${e.message}`); }

  let stdio = ["ignore", "ignore", "ignore"];
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  }
  const env = {
    ...process.env,
    CICY_CODE_PORT: String(port),
    PORT: String(port),
  };
  // --helper removed (主人指令): Windows now runs cicy-code in normal mode (full
  // tmux-based multi-agent via the bundled MSYS2 runtime), same as mac/linux —
  // no longer the single headless 团队助手.
  const args = ["--desktop"];
  child = spawn(exe, args, { stdio, detached: false, windowsHide: true, env });
  console.log(`[cicy-code-sidecar] spawned ${exe} ${args.join(" ")} pid=${child.pid} port=${port} log=${logPath || "(none)"}`);

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
  // Windows has no lsof — find the LISTENING PID on the port via netstat instead.
  // Needed so stop()/update() can actually kill the old cicy-code.exe holding
  // :8008 before launching the new version (else the new one can't bind and the
  // update silently "succeeds" while the OLD version keeps running).
  if (process.platform === "win32") {
    try {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === port) pids.add(parseInt(m[2], 10));
      }
      return [...pids].filter(n => n > 0);
    } catch { return []; }
  }
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
  // 1) The child we spawned this session (npx), the Docker container, or the
  // native exe.
  if (child) {
    const p = child;
    child = null;
    if (p.docker) {
      try { await require("./docker").stop(); } catch {}
      return;
    }
    if (p.native) {
      try { await require("./native").stop({ port }); } catch {}
      return;
    }
    try { p.kill("SIGTERM"); } catch {}
    const t0 = Date.now();
    while (p.exitCode === null && Date.now() - t0 < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (p.exitCode === null) { try { p.kill("SIGKILL"); } catch {} }
  }

  // 2) Anything STILL on :port we didn't spawn — a detached prior launch, a
  //    user-run daemon, an orphan. The homepage 停止/重启 + update() must act on
  //    the REAL listener; otherwise (no tracked child) it would no-op.
  //    Windows: the old Docker-route skip was WRONG (win is native cicy-code.exe
  //    now) — it left the old daemon alive so update() couldn't replace the exe
  //    (new binary on disk, but the OLD version kept running on :port → "更新完成"
  //    yet still old). Hard-kill cicy-code.exe by image name + free the port.
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/F", "/IM", "cicy-code.exe"], { stdio: "ignore" }); } catch {}
  }
  await killPortListeners(port, timeoutMs);
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

// Update (UNIFIED, all platforms): npm is ONLY the download channel — `npm pack`
// the latest per-platform subpackage into ~/.local/bin as a NEW version-named
// binary, re-point cicy-code at it (re-copy on Windows), then stop + start from
// that stable path and health-verify.
let _updating = false;
function isUpdating() { return _updating; }

async function update({ logPath, port = DEFAULT_PORT, emit } = {}) {
  const e = emit || (() => {});
  const localbin = require("./localbin");
  // Suspend the health watchdog for the duration: update() stops cicy-code, then
  // downloads (~30s) before starting the new one — during that gap the watchdog
  // would see the daemon "unreachable" and RESPAWN the OLD binary, racing the
  // swap (holding the port / locking the .exe) so the new version never takes.
  // main.js's watchdog tick checks isUpdating() and skips while this is true.
  _updating = true;
  try {
    // 主人令:更新 = 杀干净 cicy-code.exe → 起 cicy-code.exe → 探活 → 拿运行中真实
    // version → 再判定"已是最新"。绝不凭磁盘 manifest 直接喊"已是最新"——manifest
    // 可能比运行中的进程超前,甚至 daemon 根本没起。唯一可信的是运行中 /api/health
    // 报的版本。所以这个流程对"已是最新"和"要升级"两种情况一视同仁:总是重启 + 验证。
    e({ phase: "download", status: "running", message: "检查最新版本…" });
    const latest = await localbin.latestVersion();
    if (!latest) throw new Error("无法获取最新版本号");
    const cur = localbin.currentVersion();              // 磁盘 manifest:只用来决定要不要下载
    const needDownload = !cur || localbin.cmpVer(latest, cur) > 0;

    // 1) 杀干净
    e({ phase: "swap", status: "running", message: "停止 cicy-code…" });
    await stop({ port });
    await new Promise(r => setTimeout(r, 400));

    // 2) 落后才下载(此时 cicy-code.exe 已死,Windows 也能覆盖)
    if (needDownload) {
      e({ phase: "download", status: "running", message: `下载 ${latest}…` });
      await localbin.fetchToLocalBin(latest, { emit });
    }

    // 3) 起
    e({ phase: "swap", status: "running", message: "启动 cicy-code…" });
    const c = await start({ logPath, port, force: true });

    // 4) 探活:等 TCP 监听起来。注意:cicy-code 启动会先恢复团队的 agent 面板
    //    (w-1xx,可能十几个),:8008 在这些 REPL 拉起之后才 bind —— 繁忙团队这一步
    //    可能要 1~2 分钟。所以探活窗口放到 180s(原 60s 太短,会把"还在恢复 agent"
    //    误判成"启动失败",抽屉卡在「启动 cicy-code…」)。子进程一旦真退出(崩了)
    //    立即停手,不空等满 180s。
    const PROBE_TRIES = 360; // 360 * 500ms = 180s
    let up = false;
    for (let i = 0; i < PROBE_TRIES; i++) {
      if (await probeExisting(port)) { up = true; break; }
      if (c && c.exitCode != null) break;     // 进程已退出 = 真失败,别空等
      if (i === 30) e({ phase: "swap", status: "running", message: "启动 cicy-code…(正在恢复 agent 面板,稍候)" });
      await new Promise(r => setTimeout(r, 500));
    }
    if (!up) { e({ phase: "done", status: "error", message: `cicy-code 未在 ${PROBE_TRIES / 2}s 内启动` }); return c; }

    // 5) 拿运行中真实 version(唯一来源 version.running();可能略慢于 TCP,重试几次)
    const version = require("./version");
    let running = "";
    for (let i = 0; i < 20 && !running; i++) {
      running = await version.running(port);
      if (!running) await new Promise(r => setTimeout(r, 500));
    }

    // 6) 以运行中真实版本判定——不撒谎
    if (running && localbin.cmpVer(running, latest) >= 0) {
      e({ phase: "done", status: "done", message: `已是最新 ${running}` });
    } else if (running) {
      e({ phase: "done", status: "done", message: `已更新到 ${running}` });
    } else {
      e({ phase: "done", status: "done", message: `已启动(版本未知,期望 ${latest})` });
    }
    return c;
  } catch (err) {
    console.warn(`[cicy-code-sidecar] update failed: ${err.message}`);
    e({ phase: "done", status: "error", message: `更新失败：${err.message}` });
    return null;
  } finally {
    _updating = false;
  }
}

module.exports = { start, stop, restart, update, probeExisting, clearNpxCache, isUpdating };
