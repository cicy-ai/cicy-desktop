// Runtime Bundle v1 — versioned component store for everything cicy-desktop
// runs locally (cicy-code, mihomo, and on Windows the slim MSYS2 tree).
//
// Layout:
//   ~/cicy-ai/runtime/
//     versions.json                  { "<comp>": { "current": "<ver>" }, ... }
//     cicy-code/<ver>/cicy-code(.exe)
//     mihomo/<ver>/mihomo(.exe)
//     msys2/<ver>/usr/bin/bash.exe   (win32 only, directory component)
//
// Sourcing order:
//   1. first run: copy out of cicy-desktop's own node_modules — the platform
//      subpackages are optionalDependencies, so `npm i -g cicy-desktop`
//      already delivered the right binaries. First start = ZERO network,
//      ZERO npx (主人指令).
//   2. upgrades: `npm pack <pkg>@<ver>` (npmmirror default) → extract into
//      runtime/<comp>/<ver>/ → caller verifies health → switchCurrent().
//      The previous version stays on disk for instant rollback.
//
// The `current` pointer lives in versions.json (NOT a symlink — Windows
// junction/symlink permissions are a minefield; a JSON pointer is identical
// on every platform).
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RUNTIME_DIR = path.join(os.homedir(), "cicy-ai", "runtime");
const VERSIONS_JSON = path.join(RUNTIME_DIR, "versions.json");
const REGISTRY = process.env.CICY_NPM_REGISTRY || "https://registry.npmmirror.com";
const IS_WIN = process.platform === "win32";

function plat() {
  const osStr = IS_WIN ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const archStr = process.arch === "arm64" ? "arm64" : "x64";
  return `${osStr}-${archStr}`;
}

// kind "bin": single executable at the package root.
// kind "dir": a directory tree (msys2) — `check` is the file proving it's intact.
const COMPONENTS = {
  "cicy-code": {
    kind: "bin",
    pkg: () => `cicy-code-${plat()}`,
    bin: () => (IS_WIN ? "cicy-code.exe" : "cicy-code"),
  },
  "mihomo": {
    kind: "bin",
    // npm spam filter 403s new names containing 'win32' → windows-* naming
    pkg: () => `cicy-mihomo-${plat().replace("win32", "windows")}`,
    bin: () => (IS_WIN ? "mihomo.exe" : "mihomo"),
  },
  "msys2": {
    kind: "dir",
    winOnly: true,
    pkg: () => "cicy-msys2-windows-x64",
    check: path.join("usr", "bin", "bash.exe"),
  },
};

function readVersions() {
  try { return JSON.parse(fs.readFileSync(VERSIONS_JSON, "utf8")); } catch { return {}; }
}

function writeVersions(updater) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const next = updater(readVersions()) || {};
  const tmp = VERSIONS_JSON + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, VERSIONS_JSON);
  return next;
}

function currentVersion(comp) {
  return readVersions()[comp]?.current || null;
}

function versionDir(comp, ver) {
  return path.join(RUNTIME_DIR, comp, ver);
}

// Absolute path of the component's current payload — the executable for "bin"
// components, the root dir for "dir" components. null when not installed.
function binPath(comp) {
  const c = COMPONENTS[comp];
  const ver = currentVersion(comp);
  if (!c || !ver) return null;
  const p = c.kind === "dir" ? versionDir(comp, ver) : path.join(versionDir(comp, ver), c.bin());
  const probe = c.kind === "dir" ? path.join(p, c.check) : p;
  return fs.existsSync(probe) ? p : null;
}

function cpDirSync(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

// Install a payload directory as <comp>@<ver> and return the version dir.
// Payload = the npm package dir (or node_modules/<pkg>). Atomic-ish: extract
// to .staging then rename.
function installPayload(comp, ver, payloadDir) {
  const c = COMPONENTS[comp];
  const dst = versionDir(comp, ver);
  if (fs.existsSync(dst)) return dst; // already installed — idempotent
  const staging = dst + ".staging";
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  if (c.kind === "dir") {
    // The 118MB+ MSYS2 tree ships as a single .tar.gz inside the npm package
    // (npm handles one big file far better than 10k tiny ones). Extract it;
    // otherwise the payload is already an unpacked tree → copy.
    const tgz = (() => { try { return fs.readdirSync(payloadDir).find((f) => /\.tar\.gz$/i.test(f)); } catch { return null; } })();
    if (tgz) {
      require("child_process").execFileSync("tar", ["-xzf", path.join(payloadDir, tgz), "-C", staging], { windowsHide: true });
    } else {
      cpDirSync(payloadDir, staging);
    }
    if (!fs.existsSync(path.join(staging, c.check))) {
      // the tree may be nested one level (package/msys64/usr/... or root/usr/...)
      const sub = fs.readdirSync(staging).find((d) =>
        fs.existsSync(path.join(staging, d, c.check)));
      if (!sub) { fs.rmSync(staging, { recursive: true, force: true }); throw new Error(`${comp}: ${c.check} missing in package`); }
      fs.renameSync(path.join(staging, sub), staging + ".inner");
      fs.rmSync(staging, { recursive: true, force: true });
      fs.renameSync(staging + ".inner", staging);
    }
  } else {
    const src = path.join(payloadDir, c.bin());
    if (!fs.existsSync(src)) { fs.rmSync(staging, { recursive: true, force: true }); throw new Error(`${comp}: ${c.bin()} missing in package`); }
    fs.copyFileSync(src, path.join(staging, c.bin()));
    if (!IS_WIN) fs.chmodSync(path.join(staging, c.bin()), 0o755);
  }
  fs.renameSync(staging, dst);
  return dst;
}

function switchCurrent(comp, ver) {
  writeVersions((v) => { v[comp] = { ...(v[comp] || {}), current: ver, switched_at: new Date().toISOString() }; return v; });
}

// Keep current + previous; GC everything older.
function gc(comp) {
  const cur = currentVersion(comp);
  const dir = path.join(RUNTIME_DIR, comp);
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((d) => !d.endsWith(".staging")); } catch { return; }
  const prev = readVersions()[comp]?.previous;
  for (const e of entries) {
    if (e !== cur && e !== prev) {
      try { fs.rmSync(path.join(dir, e), { recursive: true, force: true }); } catch {}
    }
  }
}

// Locate the platform subpackage inside cicy-desktop's own install (it's an
// optionalDependency, delivered by the same `npm i -g cicy-desktop`).
function bundledPkgDir(comp) {
  const c = COMPONENTS[comp];
  const candidates = [
    path.join(__dirname, "..", "..", "node_modules", c.pkg()),          // npm install layout
    path.join(process.resourcesPath || "", "runtime-pkgs", c.pkg()),    // packaged (NSIS/dmg) layout
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(path.join(p, "package.json"))) return p;
    } catch {}
  }
  return null;
}

// First-run seeding: make sure SOME version of `comp` is installed + current,
// sourcing from the bundled subpackage. Never touches the network.
function ensureFromBundle(comp) {
  const c = COMPONENTS[comp];
  if (!c || (c.winOnly && !IS_WIN)) return null;
  const existing = binPath(comp);
  if (existing) return existing;
  const pkgDir = bundledPkgDir(comp);
  if (!pkgDir) return null; // not bundled (e.g. dev tree) — caller may npm-install
  const ver = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  installPayload(comp, ver, pkgDir);
  if (!currentVersion(comp)) switchCurrent(comp, ver);
  return binPath(comp);
}

function npmExec(args, { timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("npm", args, { windowsHide: true, timeout, shell: IS_WIN }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve(String(stdout)));
  });
}

// Latest published version of the component's npm package.
async function checkUpdate(comp) {
  const c = COMPONENTS[comp];
  const out = await npmExec(["view", c.pkg(), "version", `--registry=${REGISTRY}`], { timeout: 30000 });
  const latest = out.trim();
  const current = currentVersion(comp);
  return { current, latest, updateAvailable: !!latest && latest !== current };
}

// Download <pkg>@<ver> via `npm pack` (pacote verifies sha512 integrity),
// extract, install as a runtime version. Does NOT switch `current` — the
// caller health-checks first, then calls switchCurrent()/rollback.
async function fetchVersion(comp, ver, { emit } = {}) {
  const c = COMPONENTS[comp];
  const e = emit || (() => {});
  if (fs.existsSync(versionDir(comp, ver))) {
    e({ phase: "download", status: "skip", message: `${comp} ${ver} 已在本地，跳过下载` });
    return versionDir(comp, ver);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cicy-rt-${comp}-`));
  try {
    e({ phase: "download", status: "running", message: `下载 ${comp} ${ver}…` });
    const out = await npmExec(["pack", `${c.pkg()}@${ver}`, `--registry=${REGISTRY}`, "--pack-destination", tmp]);
    const tgz = path.join(tmp, out.trim().split("\n").pop().trim());
    await new Promise((resolve, reject) => {
      execFile("tar", ["-xzf", tgz, "-C", tmp], { windowsHide: true, timeout: 120000 },
        (err) => (err ? reject(err) : resolve()));
    });
    const dir = installPayload(comp, ver, path.join(tmp, "package"));
    e({ phase: "download", status: "done", message: `${comp} ${ver} 就绪` });
    return dir;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Full upgrade: fetch latest → caller's stop/start hooks around the pointer
// switch → health verify → rollback on failure. Returns { ok, from, to }.
async function upgrade(comp, { emit, stop, start, verify } = {}) {
  const e = emit || (() => {});
  const from = currentVersion(comp);
  const { latest } = await checkUpdate(comp);
  if (!latest) throw new Error(`registry has no ${COMPONENTS[comp].pkg()}`);
  if (latest === from) {
    e({ phase: "done", status: "done", message: `已是最新 ${latest}` });
    return { ok: true, from, to: latest, noop: true };
  }
  await fetchVersion(comp, latest, { emit });
  e({ phase: "swap", status: "running", message: "停止当前版本…" });
  if (stop) await stop();
  writeVersions((v) => { v[comp] = { ...(v[comp] || {}), previous: from }; return v; });
  switchCurrent(comp, latest);
  e({ phase: "swap", status: "running", message: `切换到 ${latest}，启动…` });
  try {
    if (start) await start();
    if (verify && !(await verify())) throw new Error("health check failed");
  } catch (err) {
    // rollback: pointer back, restart old version
    e({ phase: "swap", status: "error", message: `新版本异常（${err.message}），回滚到 ${from}` });
    switchCurrent(comp, from);
    if (start) { try { await start(); } catch {} }
    return { ok: false, from, to: latest, rolledBack: true, error: err.message };
  }
  gc(comp);
  e({ phase: "done", status: "done", message: `已更新 ${from || "(无)"} → ${latest}` });
  return { ok: true, from, to: latest };
}

module.exports = {
  RUNTIME_DIR, COMPONENTS,
  binPath, currentVersion, ensureFromBundle, fetchVersion, switchCurrent,
  checkUpdate, upgrade, gc, readVersions,
};
