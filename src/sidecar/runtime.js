// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Runtime Bundle v2 — versioned component store for everything cicy-desktop
// runs locally (cicy-code, mihomo). Everything installs under ~/.local/bin,
// matching cicy-code / cicy-mihomo: the store is on PATH, never in a private
// ~/cicy-ai/runtime tree anymore.
//
// Layout (writes ONLY here):
//   ~/.local/bin/<comp>-<ver>          versioned binary (e.g. mihomo-1.10.4)
//   ~/.local/bin/<comp>  ->  <comp>-<ver>   symlink we swap on switch (atomic
//                                            relink; win32 copies instead —
//                                            symlink needs admin there)
//   ~/cicy-ai/db/local-bin-versions.json    { "<comp>": { "current", "previous" } }
//
// Resolution order (READS, with backward compat):
//   ~/.local/bin/<comp>-<current>  →  ~/.local/bin/<comp> symlink  →
//   legacy ~/cicy-ai/runtime/<comp>/<ver>/<bin>  (old installs still resolve
//   until their next upgrade migrates them into ~/.local/bin).
//
// Sourcing order for the binary itself:
//   1. first run: copy out of cicy-desktop's own node_modules — the platform
//      subpackages are optionalDependencies, so `npm i -g cicy-desktop`
//      already delivered the right binaries. First start = ZERO network.
//   2. migrate: if only a legacy ~/cicy-ai/runtime binary exists, copy it into
//      ~/.local/bin (no network) so the new layout takes over.
//   3. upgrades: `npm pack <pkg>@<ver>` (npmmirror default) → extract → install
//      into ~/.local/bin → caller verifies health → switchCurrent(). The
//      previous versioned file stays on disk for instant rollback.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOCAL_BIN = path.join(os.homedir(), ".local", "bin");
const VERSIONS_JSON = path.join(os.homedir(), "cicy-ai", "db", "local-bin-versions.json");
// read-only backward-compat fallbacks (never written anymore)
const LEGACY_DIR = path.join(os.homedir(), "cicy-ai", "runtime");
const LEGACY_VERSIONS = path.join(LEGACY_DIR, "versions.json");
const REGISTRY = process.env.CICY_NPM_REGISTRY || "https://registry.npmmirror.com";
const IS_WIN = process.platform === "win32";
const EXT = IS_WIN ? ".exe" : "";

// npm subpackage platform suffix. NOTE: Windows is "windows" not "win32" —
// npm's spam filter 403s NEW package names containing 'win32', so EVERY cicy
// subpackage (code/mihomo) is published as *-windows-*. This must match the
// published names exactly or both the bundled-dir lookup AND the npm-pull
// fallback fail (a 404 that stranded first start on Windows).
function plat() {
  const osStr = IS_WIN ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const archStr = process.arch === "arm64" ? "arm64" : "x64";
  return `${osStr}-${archStr}`;
}

// kind "bin": single executable at the package root.
const COMPONENTS = {
  "cicy-code": {
    kind: "bin",
    pkg: () => `cicy-code-${plat()}`,
    bin: () => `cicy-code${EXT}`,
  },
  "mihomo": {
    kind: "bin",
    pkg: () => `cicy-mihomo-${plat()}`,
    bin: () => `mihomo${EXT}`,
  },
};

// ~/.local/bin/<comp>-<ver>[.exe] — the versioned binary we own.
function binFile(comp, ver) {
  return path.join(LOCAL_BIN, `${comp}-${ver}${EXT}`);
}
// ~/.local/bin/<comp>[.exe] — the PATH entry (symlink, or copy on win32).
function linkPath(comp) {
  return path.join(LOCAL_BIN, `${comp}${EXT}`);
}
// legacy ~/cicy-ai/runtime/<comp>/<ver>/<bin> — read-only compat.
function legacyBinPath(comp, ver) {
  const c = COMPONENTS[comp];
  return c ? path.join(LEGACY_DIR, comp, ver, c.bin()) : null;
}

function readVersions() {
  for (const p of [VERSIONS_JSON, LEGACY_VERSIONS]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"));
      if (v && Object.keys(v).length) return v;
    } catch {}
  }
  return {};
}

function writeVersions(updater) {
  fs.mkdirSync(path.dirname(VERSIONS_JSON), { recursive: true });
  const next = updater(readVersions()) || {};
  const tmp = VERSIONS_JSON + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, VERSIONS_JSON);
  return next;
}

function currentVersion(comp) {
  return readVersions()[comp]?.current || null;
}

// Absolute path of the component's current executable. null when not installed.
// ~/.local/bin versioned file → symlink → legacy runtime store (compat).
function binPath(comp) {
  const c = COMPONENTS[comp];
  if (!c) return null;
  const ver = currentVersion(comp);
  if (ver) {
    const vf = binFile(comp, ver);
    if (fs.existsSync(vf)) return vf;
  }
  const lp = linkPath(comp);
  if (fs.existsSync(lp)) return lp;
  if (ver) {
    const legacy = legacyBinPath(comp, ver);
    if (legacy && fs.existsSync(legacy)) return legacy; // old install, pre-migration
  }
  return null;
}

// Copy a single executable file into ~/.local/bin/<comp>-<ver>. Atomic-ish
// (stage under a temp name, then rename). Idempotent.
function installFromFile(comp, ver, srcFile) {
  const dst = binFile(comp, ver);
  if (fs.existsSync(dst)) return dst;
  if (!fs.existsSync(srcFile)) throw new Error(`${comp}: source binary missing (${srcFile})`);
  fs.mkdirSync(LOCAL_BIN, { recursive: true });
  const staging = dst + ".staging";
  try { fs.rmSync(staging, { force: true }); } catch {}
  fs.copyFileSync(srcFile, staging);
  if (!IS_WIN) fs.chmodSync(staging, 0o755);
  fs.renameSync(staging, dst);
  return dst;
}

// Install a payload directory (the npm package dir) as <comp>@<ver>.
function installPayload(comp, ver, payloadDir) {
  const c = COMPONENTS[comp];
  return installFromFile(comp, ver, path.join(payloadDir, c.bin()));
}

// Point ~/.local/bin/<comp> at <comp>-<ver>. Symlink on posix (atomic
// tmp+rename), copy on win32 (symlink there needs admin — same call the
// cicy-mihomo/cicy-code installers make).
function relink(comp, ver) {
  const target = binFile(comp, ver);
  if (!fs.existsSync(target)) return;
  const link = linkPath(comp);
  fs.mkdirSync(LOCAL_BIN, { recursive: true });
  if (IS_WIN) {
    try { fs.rmSync(link, { force: true }); } catch {}
    try { fs.copyFileSync(target, link); } catch {}
    return;
  }
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, link); // atomically replaces the old symlink
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function switchCurrent(comp, ver) {
  writeVersions((v) => { v[comp] = { ...(v[comp] || {}), current: ver, switched_at: new Date().toISOString() }; return v; });
  relink(comp, ver);
}

// Keep current + previous versioned files; GC everything older in ~/.local/bin.
function gc(comp) {
  const cur = currentVersion(comp);
  const prev = readVersions()[comp]?.previous;
  const prefix = `${comp}-`;
  let entries = [];
  try { entries = fs.readdirSync(LOCAL_BIN); } catch { return; }
  for (const e of entries) {
    if (!e.startsWith(prefix)) continue; // skips the bare "<comp>" symlink too
    if (e.endsWith(".staging") || e.includes(".tmp-")) { try { fs.rmSync(path.join(LOCAL_BIN, e), { force: true }); } catch {} continue; }
    const ver = e.slice(prefix.length).replace(/\.exe$/, "");
    if (ver !== cur && ver !== prev) {
      try { fs.rmSync(path.join(LOCAL_BIN, e), { force: true }); } catch {}
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

// First-run seeding / migration: make sure the current `comp` binary lives in
// ~/.local/bin and its symlink is current. Never touches the network.
//   • already in ~/.local/bin → just fix the symlink.
//   • only a legacy ~/cicy-ai/runtime copy → migrate it into ~/.local/bin.
//   • nothing → copy from the bundled subpackage.
function ensureFromBundle(comp) {
  const c = COMPONENTS[comp];
  if (!c) return null;
  const cur = currentVersion(comp);

  if (cur && fs.existsSync(binFile(comp, cur))) { relink(comp, cur); return binFile(comp, cur); }

  // migrate a legacy runtime-store install into ~/.local/bin (no network)
  if (cur) {
    const legacy = legacyBinPath(comp, cur);
    if (legacy && fs.existsSync(legacy)) {
      try { installFromFile(comp, cur, legacy); switchCurrent(comp, cur); return binPath(comp); } catch {}
    }
  }

  // seed from the bundled optionalDependency subpackage
  const pkgDir = bundledPkgDir(comp);
  if (!pkgDir) return binPath(comp); // dev tree / not bundled — may still resolve via legacy or symlink
  const ver = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  installPayload(comp, ver, pkgDir);
  if (!currentVersion(comp) || !fs.existsSync(binFile(comp, currentVersion(comp)))) switchCurrent(comp, ver);
  else relink(comp, currentVersion(comp));
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
// extract, install into ~/.local/bin. Does NOT switch `current` — the caller
// health-checks first, then calls switchCurrent()/rollback.
async function fetchVersion(comp, ver, { emit } = {}) {
  const c = COMPONENTS[comp];
  const e = emit || (() => {});
  if (fs.existsSync(binFile(comp, ver))) {
    e({ phase: "download", status: "skip", message: `${comp} ${ver} 已在本地，跳过下载` });
    return binFile(comp, ver);
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
    const file = installPayload(comp, ver, path.join(tmp, "package"));
    e({ phase: "download", status: "done", message: `${comp} ${ver} 就绪` });
    return file;
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
    if (from) switchCurrent(comp, from);
    if (start) { try { await start(); } catch {} }
    return { ok: false, from, to: latest, rolledBack: true, error: err.message };
  }
  gc(comp);
  e({ phase: "done", status: "done", message: `已更新 ${from || "(无)"} → ${latest}` });
  return { ok: true, from, to: latest };
}

module.exports = {
  LOCAL_BIN, COMPONENTS,
  binPath, binFile, linkPath, currentVersion, ensureFromBundle, fetchVersion, switchCurrent,
  checkUpdate, upgrade, gc, readVersions,
};
