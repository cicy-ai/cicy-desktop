// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

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
const localbin = require("./localbin");
const { t } = require("../i18n"); // 安装/升级日志走 i18n(main 进程按 app 语言初始化)

// ── Node runtime bootstrap ───────────────────────────────────────────────────
// (2026-06): native cicy-code 走 `npx cicy-code`,需要一个**可用**的 Node。但用户
// 机器可能没 node,或 node 太老(实测 josephs 是 node v13/npx6,老 npx 跑不动)。所以:
// 系统有 node≥20 就用;没有/太老 → 下载 Node 24 到 ~/.local/node(免 sudo,用户自己
// 拥有);下载也失败 → 提示用户去 nodejs.org 自己装。老装在 ~/cicy-ai/runtime/node 的
// 树:ensureNode 首次同盘 rename 迁进 ~/.local/node,迁不动也能被 legacy 搜索路径命中。
const NODE_VER = process.env.CICY_NODE_VERSION || "v24.18.0";
const NODE_HOME = path.join(os.homedir(), ".local", "node");
const LEGACY_NODE_HOME = path.join(os.homedir(), "cicy-ai", "runtime", "node"); // read-only compat
const NODE_SEARCH = ["/usr/local/bin", "/opt/homebrew/bin", path.join(os.homedir(), ".local", "bin"), path.join(NODE_HOME, "bin"), path.join(LEGACY_NODE_HOME, "bin")];
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
  // 找到/装完 node 就**立刻把它的 bin 放进本进程 PATH 首位**(指出的 bug): 否则后续任何不显式
  // 传 PATH 的 execFile("npm"/"npx"/"tar"...) 还会命中系统老 node(如 josephs 的 node13)。放在 ensureNode
  // 里 → 所有调用方、所有 return 分支都覆盖,不会漏。
  const adopt = (dir) => {
    if (dir) {
      if (!String(process.env.PATH || "").split(":").includes(dir)) {
        process.env.PATH = `${dir}:${process.env.PATH || ""}`;
      }
      // 我们装的 runtime node → 软链 node/npm/npx 进 ~/.local/bin,用户 shell 直接能用。
      if (dir === path.join(NODE_HOME, "bin")) linkBinsToDefaultPath(dir, ["node", "npm", "npx"], e);
    }
    return dir;
  };
  // Migrate a legacy ~/cicy-ai/runtime/node tree into ~/.local/node — same-fs
  // rename is instant. Cross-fs (EXDEV) → leave it; the legacy NODE_SEARCH dir
  // still finds it. New downloads (below) land in ~/.local/node directly.
  try {
    if (!fs.existsSync(path.join(NODE_HOME, "bin", "node")) && fs.existsSync(path.join(LEGACY_NODE_HOME, "bin", "node"))) {
      fs.mkdirSync(path.dirname(NODE_HOME), { recursive: true });
      fs.renameSync(LEGACY_NODE_HOME, NODE_HOME);
    }
  } catch {}
  let dir = findUsableNode();
  if (dir) return adopt(dir);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const fname = `node-${NODE_VER}-darwin-${arch}.tar.gz`;
  const urls = [
    `https://cdn.npmmirror.com/binaries/node/${NODE_VER}/${fname}`, // CN-fast
    `https://nodejs.org/dist/${NODE_VER}/${fname}`,                 // 官方兜底
  ];
  e({ phase: "node", status: "running", message: t("sidecar.nodeInstalling", { ver: NODE_VER }) });
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
        e({ phase: "node", status: "done", message: t("sidecar.nodeDone", { ver: NODE_VER, dir: path.join(NODE_HOME, "bin") }) });
        return adopt(path.join(NODE_HOME, "bin"));
      }
      e({ phase: "node", status: "running", message: t("sidecar.nodeExtractRetry") });
    } catch (err) {
      console.warn(`[cicy-code-sidecar] node install failed (${url}): ${err.message}`);
      e({ phase: "node", status: "running", message: t("sidecar.nodeDownloadFail", { src: url.includes("npmmirror") ? "npmmirror" : "nodejs.org", err: String(err.message).slice(0, 160) }) });
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  e({ phase: "node", status: "error", message: t("sidecar.nodeFailed") });
  return null;
}

// ── 网络环境探测(CN 用 npmmirror,海外用 npmjs)──────────────────────────────
// (npx 执行前要看本机网络,CN 用 CN mirror): 探 generate_204,能 204(够到 Google/有代理)
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

// 把 runtime 二进制软链进 ~/.local/bin —— cicy 约定的用户 bin(cicy-code setup 会把它加进 shell
// PATH,cicy-mihomo 包装器也在那),用户 shell 里直接 `node`/`npm`/`mihomo` 就能用,不用全路径。
const LOCAL_BIN = path.join(os.homedir(), ".local", "bin");
function linkBinsToDefaultPath(srcDir, names, e) {
  try {
    fs.mkdirSync(LOCAL_BIN, { recursive: true });
    for (const x of names) {
      const target = path.join(srcDir, x);
      if (!fs.existsSync(target)) continue;
      const link = path.join(LOCAL_BIN, x);
      try { fs.unlinkSync(link); } catch {}
      try { fs.symlinkSync(target, link); } catch (err) { e && e({ phase: "deps", status: "running", message: t("sidecar.linkFail", { link, err: err.message }) }); }
    }
    e && e({ phase: "deps", status: "running", message: t("sidecar.linked", { names: names.join("/") }) });
  } catch {}
}
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
    ch.on("error", (err) => { e({ phase: "deps", status: "running", message: t("sidecar.brewSpawnFail", { dep, err: err.message }) }); resolve(false); });
  });
}

// 完整环境引导:CN 探测 → node24 → brew → brew 装 tmux/jq → mihomo(best-effort)。
// 返回 { nodeBinDir, registry } 或 null(失败,drawer 已 emit 原因 + 可重试)。
async function ensureEnv({ emit } = {}) {
  const e = emit || (() => {});
  // 1) 检查网络是否为 CN → 选 registry + bottle 镜像
  e({ phase: "net", status: "running", message: t("sidecar.netChecking") });
  const cn = process.env.CICY_NPM_REGISTRY ? true : await probeIsCN();
  const registry = process.env.CICY_NPM_REGISTRY || (cn ? "https://registry.npmmirror.com" : "https://registry.npmjs.org");
  e({ phase: "net", status: "running", message: t("sidecar.netResult", { net: cn ? t("sidecar.netCN") : t("sidecar.netNonCN"), registry: registry.replace(/^https?:\/\//, ""), mirror: cn ? t("sidecar.netMirror") : "" }) });

  // 2) Node(系统 ≥20 用,否则装 Node 24)—— ensureNode 内部已把 node bin 放进 process.env.PATH 首位。
  const nodeBinDir = await ensureNode({ emit });
  if (!nodeBinDir) return null;

  // 3+4) Homebrew + tmux/jq(cicy-code 跑 tmux 多 agent 必需,首次它自己装很慢且会和我们抢锁,
  // 所以这里**预装好**,cicy-code 启动时已就绪)。
  const pathEnv = `${nodeBinDir}:${BREW_DIRS.join(":")}:${NODE_SEARCH.join(":")}:/usr/bin:/bin:${process.env.PATH || ""}`;
  const brew = findBrew();
  if (!brew) {
    e({ phase: "deps", status: "error", message: t("sidecar.brewMissing") + "\n/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"" });
    return null;
  }
  const brewEnv = { ...process.env, PATH: pathEnv, HOMEBREW_NO_AUTO_UPDATE: "1", ...(cn ? { HOMEBREW_BOTTLE_DOMAIN: process.env.HOMEBREW_BOTTLE_DOMAIN || "https://mirrors.ustc.edu.cn/homebrew-bottles" } : {}) };
  for (const dep of ["tmux", "jq"]) {
    if (cmdExists(dep, pathEnv)) { e({ phase: "deps", status: "running", message: t("sidecar.depInstalled", { dep }) }); continue; }
    e({ phase: "deps", status: "running", message: t("sidecar.depInstalling", { dep }) });
    const ok = await brewInstallStream(brew, dep, brewEnv, e);
    if (!ok) { e({ phase: "deps", status: "error", message: t("sidecar.depFail", { dep }) }); return null; }
    e({ phase: "deps", status: "running", message: t("sidecar.depDone", { dep }) });
  }


  // mihomo 二进制 —— desktop 用自己装的 node24 预装(诊断的根因 + 修法):
  //   cicy-code 装 mihomo 二进制走 `npm pack cicy-mihomo-<os>-<arch>`;josephs 之前是系统 node13
  //   (自带 npm6 太老)→ pack 不下来 → 二进制装不上(cicy-mihomo skill 包装器本身不需要 npm 能装,
  //   但**二进制**需要)。所以这里用 ensureNode 装好的 **node24** 把二进制 `npm pack` 进 runtime store
  //   (~/cicy-ai/runtime/mihomo/<ver>/mihomo,走现成 runtime.js,无签名/quarantine 问题),再把路径
  //   通过 MIHOMO_BIN 注入给 cicy-code → 它的 cicy-mihomo 包装器直接用,不再依赖 cicy-code 侧 npm 版本。
  //   best-effort:装不上不挡 cicy-code 启动(mihomo 只是 Chrome 代理才用)。
  let mihomoBin = null;
  try {
    const runtime = require("./runtime");
    // ensureFromBundle migrates a legacy ~/cicy-ai/runtime mihomo into ~/.local/bin
    // (no network) and fixes the symlink; falls through to the npm-pack path below
    // when nothing is bundled/installed yet.
    mihomoBin = runtime.ensureFromBundle("mihomo") || runtime.binPath("mihomo");
    if (!mihomoBin) {
      const prevPath = process.env.PATH;
      process.env.PATH = `${nodeBinDir}:${BREW_DIRS.join(":")}:${process.env.PATH || ""}`; // 让 runtime 的 execFile("npm") 命中 node24
      try {
        e({ phase: "deps", status: "running", message: t("sidecar.mihomoInstalling") });
        const { latest } = await runtime.checkUpdate("mihomo");
        if (latest) {
          await runtime.fetchVersion("mihomo", latest, { emit: e });
          runtime.switchCurrent("mihomo", latest);
          mihomoBin = runtime.binPath("mihomo");
        }
      } finally { process.env.PATH = prevPath; }
    }
    if (mihomoBin) {
      // runtime.js already owns ~/.local/bin/mihomo (symlink → mihomo-<ver>); no
      // extra linking here (mihomoBin is itself under ~/.local/bin now, so the old
      // linkBinsToDefaultPath call would have symlinked it to itself).
      e({ phase: "deps", status: "done", message: t("sidecar.mihomoReady", { bin: mihomoBin }) });
    }
  } catch (err) {
    e({ phase: "deps", status: "running", message: t("sidecar.mihomoSkip", { err: String(err.message).slice(0, 160) }) });
  }

  return { nodeBinDir, registry, mihomoBin };
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

// 「局域网访问」开关持久化: 存 ~/cicy-ai/db/desktop-flags.json 的 public 字段。
// start() 读它决定 npx cicy-code 加不加 --public。renderer 通过 sidecar:getPublic/setPublic 读写。
// 不再放 ~/cicy-ai/runtime;老位置只读兜底,首次写入即迁移(public/cft token 不丢)。
const FLAGS_FILE = path.join(os.homedir(), "cicy-ai", "db", "desktop-flags.json");
const LEGACY_FLAGS_FILE = path.join(os.homedir(), "cicy-ai", "runtime", "desktop-flags.json");
function readFlags() {
  for (const p of [FLAGS_FILE, LEGACY_FLAGS_FILE]) {
    try { const v = JSON.parse(fs.readFileSync(p, "utf8")); if (v && typeof v === "object") return v; } catch {}
  }
  return {};
}
function isPublic() { return !!readFlags().public; }
function setPublicFlag(on) {
  const f = readFlags(); f.public = !!on;
  try { fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true }); fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.warn(`[cicy-code-sidecar] setPublicFlag write failed: ${e.message}`); }
  return f.public;
}

// 「容器内使用 Docker」开关(desktop-flags.json 的 dood 字段 = Docker-outside-of-Docker)。
// 开启后 runContainer 把宿主 dockerd 的 /var/run/docker.sock 挂进容器,并把 docker CLI 装进
// 容器持久卷,容器内 agent 就能跑 docker。只影响 Windows/WSL(+mac colima)容器路径。
function isDood() { return !!readFlags().dood; }
function setDood(on) {
  const f = readFlags(); f.dood = !!on;
  try { fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true }); fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.warn(`[cicy-code-sidecar] setDood write failed: ${e.message}`); }
  return f.dood;
}

// 「Cloudflare Tunnel」配置持久化(同 desktop-flags.json 的 cft 字段):
// { enabled, token, host }。enabled 且 token 非空时,start() 注入 CICY_CFT_TOKEN/
// CICY_CFT_HOST 环境变量 —— cicy-code 据此跑一条命名隧道(固定域名)。host 是对外
// 公布的 FQDN(可空,命名隧道的 hostname 也可在 Cloudflare 面板里配)。
function getCft() {
  const c = readFlags().cft || {};
  return { enabled: !!c.enabled, token: c.token || "", host: c.host || "" };
}
function setCft(cfg = {}) {
  const f = readFlags();
  f.cft = { enabled: !!cfg.enabled, token: String(cfg.token || "").trim(), host: String(cfg.host || "").trim() };
  try { fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true }); fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.warn(`[cicy-code-sidecar] setCft write failed: ${e.message}`); }
  return getCft();
}
// Env the tunnel needs when enabled (shared by native spawn + the Windows container).
function cftEnv() {
  const c = getCft();
  if (!c.enabled || !c.token) return {};
  return { CICY_CFT_TOKEN: c.token, ...(c.host ? { CICY_CFT_HOST: c.host } : {}) };
}

// Zero-trust gateway tunnel (paid tiers) — the managed counterpart to cft above.
// { enabled, url, token, slug }: when enrolled (via cloud /api/gateway/enroll),
// inject CICY_GATEWAY_URL (wss://<slug>.gw.cicy-ai.com/_tunnel/connect) + the
// node-token so cicy-code dials OUT to the gateway. Mirrors getCft/setCft/cftEnv.
function getGateway() {
  const c = readFlags().gateway || {};
  return { enabled: !!c.enabled, url: c.url || "", token: c.token || "", slug: c.slug || "" };
}
function setGateway(cfg = {}) {
  const f = readFlags();
  f.gateway = { enabled: !!cfg.enabled, url: String(cfg.url || "").trim(), token: String(cfg.token || "").trim(), slug: String(cfg.slug || "").trim() };
  try { fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true }); fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.warn(`[cicy-code-sidecar] setGateway write failed: ${e.message}`); }
  return getGateway();
}
function gatewayEnv() {
  const c = getGateway();
  if (!c.enabled || !c.url || !c.token) return {};
  return { CICY_GATEWAY_URL: c.url, CICY_GATEWAY_TOKEN: c.token };
}


async function start({ logPath, port = DEFAULT_PORT, force = false, version = null, emit = null } = {}) {
  // **永不重复 spawn 活着的实例**(bug 修复): cicy-code 首次启动要 `brew install tmux`
  // 等依赖,要几分钟,这期间 :8008 还没 bind。watchdog(:8008 探不到)和用户点「启动」都会
  // 再调 start() —— 如果再 spawn 一个,多个实例抢 brew tmux 的锁 → 全部「环境初始化失败」→
  // :8008 永远起不来。所以:只要我们 spawn 的 child 进程还活着(没 exit),一律复用,绝不再
  // spawn,连 force 也不行(update() 是先 stop() 杀掉 child 再 start,那时 child 已 null)。
  if (child && child.exitCode == null && child.signalCode == null) {
    console.log(`[cicy-code-sidecar] already running pid=${child.pid} (setup may be in progress) — reuse, no double-spawn`);
    return child;
  }

  // (2026-06 方向回调): mac 资源吃不消 docker(colima VM 压垮内存被 jetsam 杀)→
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
  const { nodeBinDir, registry, mihomoBin } = env0;

  // 2) localbin 模型:`npm pack cicy-code-<plat>` → ~/.local/bin/cicy-code-<ver>-<plat>
  //    → ad-hoc 签名(arm64 必需) → symlink ~/.local/bin/cicy-code。**直接跑这个 symlink**:
  //    spawn 出来的就是监听 :8008 的进程本身(不再 npx→node→孙进程),child.pid 一杀就净,
  //    版本单一可信。npm 只当下载渠道(ensureEnv 已把 node/npm 放进 process.env.PATH)。
  let stdio = ["ignore", "ignore", "ignore"];
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  }
  let exe = null;
  try {
    const r = await localbin.ensure({ version: version || process.env.CICY_CODE_VERSION || null, emit });
    exe = r && r.exe;
  } catch (err) {
    console.warn(`[cicy-code-sidecar] localbin.ensure failed: ${err.message}`);
    emit && emit({ phase: "cicy-code", status: "error", message: t("sidecar.binPrepFail", { err: String(err.message).slice(0, 160) }) });
    return null;
  }
  if (!exe || !fs.existsSync(exe)) {
    console.warn("[cicy-code-sidecar] no cicy-code binary after ensure");
    emit && emit({ phase: "cicy-code", status: "error", message: t("sidecar.binMissing") });
    return null;
  }
  const childPath = `${nodeBinDir}:${BREW_DIRS.join(":")}:${NODE_SEARCH.join(":")}:/usr/bin:/bin:${process.env.PATH || ""}`;
  const env = {
    ...process.env,
    CICY_CODE_PORT: String(port),
    PORT: String(port),
    npm_config_registry: registry,
    PATH: childPath, // cicy-code 运行时找 tmux/jq(brew)+ node
    // mihomo 二进制 desktop 已用 node24 预装到 runtime store(避开 node13 的 npm6 装不上的坑)→
    // 注入 MIHOMO_BIN,cicy-code 的 cicy-mihomo 包装器直接用,不再自己 npm pack。
    ...(mihomoBin ? { MIHOMO_BIN: mihomoBin } : {}),
    // 「Cloudflare Tunnel」开启时注入 connector token(+ 可选公网 host)→ cicy-code
    // 起一条命名隧道。关闭时不注入,cicy-code 不起隧道。
    ...cftEnv(),
    // Zero-trust gateway (paid tiers): when a tunnel is enrolled, cicy-code dials
    // OUT to <slug>.gw.cicy-ai.com. Off → not injected, no gateway dial.
    ...gatewayEnv(),
  };
  // 「局域网访问」开关: 开 → 加 --public,cicy-code 绑 0.0.0.0(同局域网设备可访问,
  // api_token 仍把关);关 → 默认只绑 127.0.0.1。flag 存 runtime/desktop-flags.json。
  const args = isPublic() ? ["--public"] : [];
  emit && emit({ phase: "cicy-code", status: "running", message: t("sidecar.starting", { lan: isPublic() ? t("sidecar.lanSuffix") : "" }) });
  // 退出保活:detached + unref → 关 App 不带走 daemon(及其 tmux agent),下次 adopt。
  const detached = process.platform !== "win32";
  child = spawn(exe, args, { stdio, detached, windowsHide: true, env });
  console.log(`[cicy-code-sidecar] spawned ${exe} ${args.join(" ")} pid=${child.pid} port=${port} registry=${registry} public=${isPublic()} detached=${detached} log=${logPath || "(none)"}`);
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
// 全程标记 busy 暂停 watchdog,且**等 :8008 真正起来才释放** —— 否则 stop→start 的空窗里
// watchdog 会自己再 start 一个(默认无 --public)→ 双开抢端口(启用 LAN 时就是这个 bug)。
async function restart({ logPath, port = DEFAULT_PORT } = {}) {
  _busyDepth++;
  try {
    await stop({ port });
    await new Promise(r => setTimeout(r, 300));
    const c = await start({ logPath, port, force: true });
    // 等新实例 bind :8008 再放开 watchdog(deps 已装好,通常几秒;给足上限防卡死)
    for (let i = 0; i < 120 && !(await probeExisting(port)); i++) await new Promise(r => setTimeout(r, 500));
    return c;
  } finally {
    _busyDepth--;
  }
}

// Update (UNIFIED, all platforms): npm is ONLY the download channel — `npm pack`
// the latest per-platform subpackage into ~/.local/bin as a NEW version-named
// binary, re-point cicy-code at it (re-copy on Windows), then stop + start from
// that stable path and health-verify.
let _updating = false;
function isUpdating() { return _updating; }
// 「维护中」=update 或 restart 进行中。watchdog 查这个,任一主动生命周期操作期间都不抢着
// 自己 start,避免双开。_busyDepth 计数式(restart 内部还会 stop),嵌套安全。
let _busyDepth = 0;
function isBusy() { return _updating || _busyDepth > 0; }

async function update({ logPath, port = DEFAULT_PORT, emit } = {}) {
  const e = emit || (() => {});
  // Suspend the health watchdog for the duration (watchdog tick checks isBusy()).
  // update = 下载新版到 ~/.local/bin(版本化 + ad-hoc 签名 + 重指 symlink)→ 杀旧 → 跑新 symlink。
  // 全部走 localbin,不再碰 npx 缓存。
  _updating = true;
  try {
    // 1) 拉最新版到 ~/.local/bin(npm pack cicy-code-<plat> → 版本化 → 签名 → 重指 symlink;
    //    已是最新 localbin.update 自己返回 updated:false,不重复下载)。
    e({ phase: "download", status: "running", message: t("sidecar.checkingLatest") });
    const up = await localbin.update({ emit: e }); // { version, updated }

    // 2) 杀干净在跑的旧进程(killPortListeners 兜底,不管 child 准不准)
    e({ phase: "swap", status: "running", message: t("sidecar.swapping", { ver: up.version }) });
    await stop({ port });
    await new Promise(r => setTimeout(r, 300));

    // 3) 跑新 symlink(start→localbin.ensure 此时已是新版,直接复用)
    const c = await start({ logPath, port, force: true, emit: e });

    // 4) 探活:等 TCP 监听起来。cicy-code 启动会先恢复 agent 面板,繁忙团队 :8008 可能 1~2min
    //    才 bind。子进程一旦真退出(崩了)立即停手,不空等。
    const PROBE_TRIES = 360; // 360 * 500ms = 180s
    let alive = false;
    for (let i = 0; i < PROBE_TRIES; i++) {
      if (await probeExisting(port)) { alive = true; break; }
      if (c && c.exitCode != null) break;
      if (i === 30) e({ phase: "swap", status: "running", message: t("sidecar.startingAgents") });
      await new Promise(r => setTimeout(r, 500));
    }
    if (!alive) { e({ phase: "done", status: "error", message: t("sidecar.notUpInTime", { secs: PROBE_TRIES / 2 }) }); return c; }

    // 5) 拿运行中真实 version 报告(唯一可信来源)
    const version = require("./version");
    let running = "";
    for (let i = 0; i < 20 && !running; i++) {
      running = await version.running(port);
      if (!running) await new Promise(r => setTimeout(r, 500));
    }
    if (running && localbin.cmpVer(running, up.version) >= 0) {
      e({ phase: "done", status: "done", message: t("sidecar.upToDateVer", { ver: running }) });
    } else if (running) {
      e({ phase: "done", status: "done", message: t("sidecar.updatedTo", { ver: running }) });
    } else {
      e({ phase: "done", status: "done", message: t("sidecar.startedUnknownVer", { ver: up.version }) });
    }
    return c;
  } catch (err) {
    console.warn(`[cicy-code-sidecar] update failed: ${err.message}`);
    e({ phase: "done", status: "error", message: t("sidecar.updateFail", { err: err.message }) });
    return null;
  } finally {
    _updating = false;
  }
}

module.exports = { start, stop, restart, update, probeExisting, clearNpxCache, isUpdating, isBusy, ensureEnv, ensureNode, isPublic, setPublicFlag, isDood, setDood, getCft, setCft, cftEnv, getGateway, setGateway, gatewayEnv };
