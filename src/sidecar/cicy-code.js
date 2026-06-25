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
const { spawn, execFileSync, execFile } = require("child_process");

// ── Node runtime bootstrap ───────────────────────────────────────────────────
// 主人(2026-06): native cicy-code 走 `npx cicy-code`,需要一个**可用**的 Node。但用户
// 机器可能没 node,或 node 太老(实测 josephs 是 node v13/npx6,老 npx 跑不动)。所以:
// 系统有 node≥20 就用;没有/太老 → 下载 Node 24 到 ~/cicy-ai/runtime/node(免 sudo,
// 用户自己拥有);下载也失败 → 提示用户去 nodejs.org 自己装。
const NODE_VER = process.env.CICY_NODE_VERSION || "v24.18.0";
const NODE_HOME = path.join(os.homedir(), "cicy-ai", "runtime", "node");
const NODE_SEARCH = ["/usr/local/bin", "/opt/homebrew/bin", path.join(os.homedir(), ".local", "bin"), path.join(NODE_HOME, "bin")];
function nodeMajor(bin) {
  try { const m = String(execFileSync(bin, ["-v"], { encoding: "utf8", timeout: 5000 })).match(/v(\d+)\./); return m ? Number(m[1]) : 0; } catch { return 0; }
}
function findUsableNode() {
  for (const d of NODE_SEARCH) {
    const node = path.join(d, "node"), npx = path.join(d, "npx");
    try { if (fs.existsSync(node) && fs.existsSync(npx) && nodeMajor(node) >= 20) return d; } catch {}
  }
  return null;
}
const pexec = (cmd, args, timeout) => new Promise((res, rej) => execFile(cmd, args, { timeout, windowsHide: true }, (e) => (e ? rej(e) : res())));
// Returns a bin dir with node+npx (node≥20), or null. emit streams progress to a drawer.
async function ensureNode({ emit } = {}) {
  const e = emit || (() => {});
  let dir = findUsableNode();
  if (dir) return dir;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const fname = `node-${NODE_VER}-darwin-${arch}.tar.gz`;
  const urls = [
    `https://cdn.npmmirror.com/binaries/node/${NODE_VER}/${fname}`, // CN-fast
    `https://nodejs.org/dist/${NODE_VER}/${fname}`,                 // 官方兜底
  ];
  e({ phase: "node", status: "running", message: `未检测到可用 Node(系统无 node 或版本 <20),正在安装 Node ${NODE_VER}(约 50MB)…` });
  fs.mkdirSync(NODE_HOME, { recursive: true });
  const tmp = path.join(os.tmpdir(), `cicy-${fname}`);
  for (const url of urls) {
    try {
      e({ phase: "node", status: "running", message: `$ curl -fL -o ${tmp} ${url}` });
      await pexec("curl", ["-fL", "--retry", "2", "-o", tmp, url], 300000);
      e({ phase: "node", status: "running", message: `$ tar -xzf <node> -C ${NODE_HOME} --strip-components 1` });
      await pexec("tar", ["-xzf", tmp, "-C", NODE_HOME, "--strip-components", "1"], 120000);
      if (fs.existsSync(path.join(NODE_HOME, "bin", "node")) && fs.existsSync(path.join(NODE_HOME, "bin", "npx"))) {
        try { fs.unlinkSync(tmp); } catch {}
        e({ phase: "node", status: "done", message: `Node ${NODE_VER} 安装完成 → ${path.join(NODE_HOME, "bin")}` });
        return path.join(NODE_HOME, "bin");
      }
      e({ phase: "node", status: "running", message: `解压后没找到 node/npx,换下一个源…` });
    } catch (err) {
      console.warn(`[cicy-code-sidecar] node install failed (${url}): ${err.message}`);
      e({ phase: "node", status: "running", message: `Node 下载失败(${url.includes("npmmirror") ? "npmmirror" : "nodejs.org"}):${String(err.message).slice(0, 160)} — 换源重试…` });
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  e({ phase: "node", status: "error", message: "❌ Node 自动安装失败(两个源都没成)—— 请打开 https://nodejs.org 下载安装 Node(选 LTS),装好后点「重试」" });
  return null;
}

// ── 网络环境探测(CN 用 npmmirror,海外用 npmjs)──────────────────────────────
// 主人(npx 执行前要看本机网络,CN 用 CN mirror): 探 generate_204,能 204(够到 Google/有代理)
// = 海外;超时/失败(GFW)= CN。探一次缓存。CICY_NPM_REGISTRY 覆盖时不探。
let _cnCache = null;
function probeIsCN() {
  if (_cnCache !== null) return _cnCache;
  _cnCache = new Promise((resolve) => {
    let done = false; const fin = (cn) => { if (!done) { done = true; resolve(cn); } };
    try {
      const req = require("https").get("https://www.gstatic.com/generate_204", { timeout: 2500 }, (res) => { const ok = res.statusCode === 204; res.destroy(); fin(!ok); });
      req.on("timeout", () => { req.destroy(); fin(true); });
      req.on("error", () => fin(true));
    } catch { fin(true); }
  });
  return _cnCache;
}

// ── Homebrew + 系统依赖 ───────────────────────────────────────────────────────
const BREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
function findBrew() { for (const d of BREW_DIRS) { const p = path.join(d, "brew"); try { if (fs.existsSync(p)) return p; } catch {} } return null; }
function cmdExists(name, pathEnv) {
  try { execFileSync("bash", ["-lc", `command -v ${name} >/dev/null 2>&1`], { timeout: 8000, env: { ...process.env, PATH: pathEnv } }); return true; } catch { return false; }
}
// brew install <dep>,逐行把输出 emit 到 drawer。CN 用 USTC bottle 镜像加速。
function brewInstallStream(brew, dep, env, e) {
  return new Promise((resolve) => {
    e({ phase: "deps", status: "running", message: `$ brew install ${dep}` });
    let buf = "";
    const ch = spawn(brew, ["install", dep], { env });
    const pump = (b) => { buf += b.toString("utf8"); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).replace(/\r$/, "").trim(); buf = buf.slice(nl + 1); if (line) e({ phase: "deps", status: "running", message: line.slice(0, 200) }); } };
    ch.stdout.on("data", pump); ch.stderr.on("data", pump);
    ch.on("close", (code) => resolve(code === 0));
    ch.on("error", (err) => { e({ phase: "deps", status: "running", message: `brew install ${dep} 起不来: ${err.message}` }); resolve(false); });
  });
}

// 完整环境引导:CN 探测 → node24 → brew → brew 装 tmux/jq → mihomo(best-effort)。
// 返回 { nodeBinDir, registry } 或 null(失败,drawer 已 emit 原因 + 可重试)。
async function ensureEnv({ emit } = {}) {
  const e = emit || (() => {});
  // 1) 网络环境 → registry + bottle 镜像
  const cn = process.env.CICY_NPM_REGISTRY ? true : await probeIsCN();
  const registry = process.env.CICY_NPM_REGISTRY || (cn ? "https://registry.npmmirror.com" : "https://registry.npmjs.org");
  e({ phase: "net", status: "running", message: `网络环境:${cn ? "国内(CN)→ 用 npmmirror + USTC bottle 镜像" : "海外 → 用 npmjs"}` });

  // 2) Node(系统 ≥20 用,否则装 Node 24)
  const nodeBinDir = await ensureNode({ emit });
  if (!nodeBinDir) return null;

  // 3+4) Homebrew + tmux/jq(cicy-code 跑 tmux 多 agent 必需,首次它自己装很慢且会和我们抢锁,
  // 所以这里**预装好**,cicy-code 启动时已就绪)。
  const pathEnv = `${nodeBinDir}:${BREW_DIRS.join(":")}:${NODE_SEARCH.join(":")}:/usr/bin:/bin:${process.env.PATH || ""}`;
  const brew = findBrew();
  if (!brew) {
    e({ phase: "deps", status: "error", message: "❌ 未检测到 Homebrew(装 tmux 等依赖要用)。请在「终端」执行后点「重试」:\n/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"" });
    return null;
  }
  const brewEnv = { ...process.env, PATH: pathEnv, HOMEBREW_NO_AUTO_UPDATE: "1", ...(cn ? { HOMEBREW_BOTTLE_DOMAIN: process.env.HOMEBREW_BOTTLE_DOMAIN || "https://mirrors.ustc.edu.cn/homebrew-bottles" } : {}) };
  for (const dep of ["tmux", "jq"]) {
    if (cmdExists(dep, pathEnv)) { e({ phase: "deps", status: "running", message: `✓ ${dep} 已安装` }); continue; }
    e({ phase: "deps", status: "running", message: `安装依赖 ${dep}(可能要几分钟)…` });
    const ok = await brewInstallStream(brew, dep, brewEnv, e);
    if (!ok) { e({ phase: "deps", status: "error", message: `❌ brew install ${dep} 失败(见上方日志),点「重试」` }); return null; }
    e({ phase: "deps", status: "running", message: `✓ ${dep} 安装完成` });
  }

  // 5) mihomo(Chrome 代理用,best-effort —— 失败不挡 cicy-code 启动)
  try {
    if (!cmdExists("mihomo", pathEnv) && !cmdExists("cicy-mihomo", pathEnv)) {
      e({ phase: "deps", status: "running", message: `$ npx -y cicy-mihomo install(后台,失败不影响启动)` });
      const m = spawn(path.join(nodeBinDir, "npx"), ["-y", "cicy-mihomo", "install"], { env: { ...process.env, PATH: pathEnv, npm_config_registry: registry }, stdio: "ignore", detached: true });
      m.unref();
    }
  } catch {}

  return { nodeBinDir, registry };
}

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
  const c = spawn(exe, ["--desktop"], { stdio, detached: false, windowsHide: true, env });
  console.log(`[cicy-code-sidecar] spawned runtime ${exe} --desktop (v${runtime.currentVersion("cicy-code")}) pid=${c.pid} port=${port}`);
  c.on("exit", (code, signal) => {
    console.log(`[cicy-code-sidecar] exited code=${code} signal=${signal}`);
    child = null;
  });
  return c;
}

async function start({ logPath, port = DEFAULT_PORT, force = false, version = null, emit = null } = {}) {
  // **永不重复 spawn 活着的实例**(主人 bug 修复): cicy-code 首次启动要 `brew install tmux`
  // 等依赖,要几分钟,这期间 :8008 还没 bind。watchdog(:8008 探不到)和用户点「启动」都会
  // 再调 start() —— 如果再 spawn 一个,多个实例抢 brew tmux 的锁 → 全部「环境初始化失败」→
  // :8008 永远起不来。所以:只要我们 spawn 的 child 进程还活着(没 exit),一律复用,绝不再
  // spawn,连 force 也不行(update() 是先 stop() 杀掉 child 再 start,那时 child 已 null)。
  if (child && child.exitCode == null && child.signalCode == null) {
    console.log(`[cicy-code-sidecar] already running pid=${child.pid} (setup may be in progress) — reuse, no double-spawn`);
    return child;
  }

  // 主人(2026-06 方向回调): mac 资源吃不消 docker(colima VM 压垮内存被 jetsam 杀)→
  // macOS/Linux 改回 native cicy-code(:8008,走 `npx cicy-code`)。Windows 仍走 docker。
  if (process.platform === "win32") return null;

  if (!force && await probeExisting(port)) {
    console.log(`[cicy-code-sidecar] existing instance on :${port}, reusing`);
    return null;
  }

  // 1) 完整环境引导(CN 探测 → node24 → brew → 预装 tmux/jq → mihomo),全程 emit 到 drawer。
  //    预装好依赖,cicy-code 启动时已就绪、不再自己慢慢 brew 装、不再和我们抢锁。
  const env0 = await ensureEnv({ emit });
  if (!env0) { console.warn("[cicy-code-sidecar] ensureEnv failed — cannot start"); return null; }
  const { nodeBinDir, registry } = env0;

  // 2) `npx cicy-code` —— npm 按本机真实架构拉 cicy-code-<plat>,文件用户自己拥有(无跨架构/
  //    权限坑)。用上面那个 Node 的 npx,并把它的 bin + brew 放 PATH 首位让 cicy-code 找到 tmux/jq。
  let stdio = ["ignore", "ignore", "ignore"];
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  }
  const npxAbs = path.join(nodeBinDir, "npx");
  const childPath = `${nodeBinDir}:${BREW_DIRS.join(":")}:${NODE_SEARCH.join(":")}:/usr/bin:/bin:${process.env.PATH || ""}`;
  const env = {
    ...process.env,
    CICY_CODE_PORT: String(port),
    PORT: String(port),
    npm_config_registry: registry,
    PATH: childPath, // 给 npx 自己找 node/npm
  };
  const spec = version ? `cicy-code@${version}`
    : (process.env.CICY_CODE_VERSION ? `cicy-code@${process.env.CICY_CODE_VERSION}` : "cicy-code");
  emit && emit({ phase: "cicy-code", status: "running", message: "启动 cicy-code(首次会下载 + 装依赖,请稍候)…" });
  // 退出保活(主人):detached + unref → 关 App 不带走 daemon(及其 tmux agent),下次 adopt。
  const detached = process.platform !== "win32";
  child = spawn(npxAbs, ["-y", spec], { stdio, detached, windowsHide: true, env });
  console.log(`[cicy-code-sidecar] spawned ${npxAbs} -y ${spec} pid=${child.pid} port=${port} registry=${registry} detached=${detached} log=${logPath || "(none)"}`);
  if (detached) { try { child.unref(); } catch {} }

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

module.exports = { start, stop, restart, update, probeExisting, clearNpxCache, isUpdating, ensureEnv, ensureNode };
