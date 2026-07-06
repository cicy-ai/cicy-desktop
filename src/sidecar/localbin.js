// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// ~/.local/bin install model for the binaries cicy-desktop OWNS.
//
// (2026-06): cicy-desktop OWNS its runtime binaries and distributes
// them THROUGH npm — one channel for everything. Today that's two components:
//
//   cicy-code  ← npm  cicy-code-<plat>     → ~/.local/bin/cicy-code
//   mihomo     ← npm  cicy-mihomo-<plat>   → ~/.local/bin/mihomo
//
// Each is bundled per-platform as an optionalDependency of cicy-desktop. On
// first run we copy the bundled, version-named binary into
// ~/.local/bin/<base>-<ver>-<plat> and point ~/.local/bin/<base> at it
// (symlink on mac/linux; a plain COPY on Windows — symlink/junction perms there
// are a minefield). The binary is ALWAYS run from that stable ~/.local/bin path
// — never `npx`, which would reuse a stale globally-installed copy and shadow
// updates.
//
// Semantics : 有就不装、没有就装、版本高了就更新、不重复下载/更新.
//   - present & current     → reuse, no work, no network
//   - absent                → seed from the bundle (zero network)
//   - bundle newer than link → re-seed from the bundle (zero network upgrade,
//                              e.g. after cicy-desktop itself updated)
//   - explicit update()     → npm `pack` the latest per-platform subpackage,
//                             ONLY when the registry is actually ahead.
//
// Updates use npm ONLY as a download channel: `npm pack` the per-platform
// subpackage (sha512-verified), extract the binary, copy it in as a NEW
// version-named file, then re-point the link (re-copy on Windows). A version
// manifest at ~/.local/bin/.cicy-localbin.json records what each link points
// at, so version checks work cross-platform (including the Windows copy, which
// has no symlink target to parse).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const { t } = require("../i18n"); // 安装/升级日志走 i18n

const IS_WIN = process.platform === "win32";
const NPMMIRROR = "https://registry.npmmirror.com"; // CN-fast
const NPMJS = "https://registry.npmjs.org";         // 官方,新版本/新子包先到这

// (2026-06): 按网络环境选 registry 顺序,两边都用各自最快的源(对方做回退)。
//   CN(GFW 内):npmmirror 优先 → npmjs 兜底
//   非CN:        npmjs 优先     → npmmirror 兜底(npmmirror 海外慢,别让它当首选)
// 判断:探 generate_204 —— 能 204(够到 Google/有代理)= 非CN;超时/失败 = CN。探一次缓存。
// CICY_NPM_REGISTRY 覆盖时强制该源优先(测试/私有源用)。
let _cnProbe = null;
function probeIsCN() {
  if (_cnProbe) return _cnProbe;
  _cnProbe = new Promise((resolve) => {
    let done = false;
    const fin = (cn) => { if (!done) { done = true; resolve(cn); } };
    try {
      const req = require("https").get("https://www.gstatic.com/generate_204", { timeout: 2000 }, (res) => {
        const ok = res.statusCode === 204; res.destroy(); fin(!ok); // 204 够到 = 非CN
      });
      req.on("timeout", () => { req.destroy(); fin(true); }); // 超时 = GFW = CN
      req.on("error", () => fin(true));                        // 连不上 = CN
    } catch { fin(true); }
  });
  return _cnProbe;
}
async function registries() {
  const override = process.env.CICY_NPM_REGISTRY;
  if (override) return [override, NPMJS, NPMMIRROR].filter((r, i, a) => a.indexOf(r) === i);
  const cn = await probeIsCN();
  return cn ? [NPMMIRROR, NPMJS] : [NPMJS, NPMMIRROR];
}
const LOCAL_BIN = path.join(os.homedir(), ".local", "bin");
const MANIFEST = path.join(LOCAL_BIN, ".cicy-localbin.json");

// The binaries we own. `pkgPrefix` + platform = the npm subpackage name;
// `base` is the stable link/file base name. The default component everywhere is
// cicy-code, so the legacy single-component callers keep working unchanged.
const COMPONENTS = {
  "cicy-code": { pkgPrefix: "cicy-code", base: "cicy-code" },
};
const DEFAULT = "cicy-code";
function comp(name) {
  const c = COMPONENTS[name || DEFAULT];
  if (!c) throw new Error(`unknown localbin component: ${name}`);
  return c;
}

function plat() {
  const osStr = IS_WIN ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${osStr}-${arch}`;
}
const pkgFor = (name) => `${comp(name).pkgPrefix}-${plat()}`;
const binFor = (name) => comp(name).base + (IS_WIN ? ".exe" : "");
const linkFor = (name) => path.join(LOCAL_BIN, binFor(name));
const versionedFor = (name, ver) =>
  path.join(LOCAL_BIN, `${comp(name).base}-${ver}-${plat()}${IS_WIN ? ".exe" : ""}`);

// Legacy aliases (cicy-code is the default component).
const BIN = binFor(DEFAULT);
const LINK = linkFor(DEFAULT);
const versioned = (ver, name = DEFAULT) => versionedFor(name, ver);

// ── version helpers ───────────────────────────────────────────────────────
// Normalize "v1.10.3" / "1.10.3" → [1,10,3]; compare numerically.
function parseVer(v) {
  return String(v || "").replace(/^v/i, "").split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
}
function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) || {}; } catch { return {}; }
}
function writeManifest(name, ver) {
  const m = readManifest();
  m[name] = ver;
  try { fs.mkdirSync(LOCAL_BIN, { recursive: true }); fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n"); } catch {}
}

// Best-effort: run the binary to read its version (fallback when the manifest
// has no record — e.g. a binary installed by the old GitHub/COS path).
function probeVersion(name) {
  const link = linkFor(name);
  if (!fs.existsSync(link)) return null;
  const flag = name === "mihomo" ? "-v" : "--version";
  try {
    const out = execFileSync(link, [flag], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/\bv?(\d+\.\d+\.\d+)\b/);
    return m ? m[1] : null;
  } catch { return null; }
}

// The version the ~/.local/bin link currently points at: manifest first (fast,
// cross-platform), else probe the binary, else null.
function currentVersion(name = DEFAULT) {
  if (!fs.existsSync(linkFor(name))) return null;
  const m = readManifest();
  if (m[name]) return m[name];
  const probed = probeVersion(name);
  if (probed) { writeManifest(name, probed); return probed; }
  return null;
}

function npmExec(args, timeout = 600000) {
  return new Promise((resolve, reject) => {
    execFile("npm", args, { windowsHide: true, timeout, shell: IS_WIN }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve(String(stdout)));
  });
}

// Latest published version of the per-platform subpackage. Tries the env-ordered
// registries (CN→npmmirror first, 非CN→npmjs first) so a not-yet-mirrored
// package/version still resolves and 非CN 不被慢镜像拖住。
async function latestVersion(name = DEFAULT) {
  let lastErr;
  for (const reg of await registries()) {
    try { return (await npmExec(["view", pkgFor(name), "version", `--registry=${reg}`], 30000)).trim(); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`latestVersion ${pkgFor(name)}: all registries failed`);
}

// Point ~/.local/bin/<base> at a version-named binary: symlink on POSIX, a plain
// copy on Windows. Records the version in the manifest.
function linkTo(name, verBinPath, ver) {
  const link = linkFor(name);
  fs.mkdirSync(LOCAL_BIN, { recursive: true });
  if (IS_WIN) {
    // Windows can't DELETE or OVERWRITE a RUNNING .exe (EPERM/EBUSY) — which is
    // exactly the update case, since cicy-code.exe is live when we re-link. But
    // Windows CAN *rename* a running exe: move the in-use link aside (unique name
    // so it never collides with an older still-running one), then copy the new
    // binary into place. The old process keeps running from the renamed file; the
    // next start picks up the new one. (Stale .old-* are harmless; best-effort swept.)
    try {
      if (fs.existsSync(link)) fs.renameSync(link, `${link}.old-${Date.now()}`);
    } catch {}
    fs.copyFileSync(verBinPath, link);
    try {
      for (const f of fs.readdirSync(LOCAL_BIN)) {
        if (f.startsWith(`${BIN}.old-`)) { try { fs.rmSync(path.join(LOCAL_BIN, f), { force: true }); } catch {} }
      }
    } catch {}
  } else {
    try { fs.rmSync(link, { force: true }); } catch {}
    fs.symlinkSync(verBinPath, link);
  }
  if (ver) writeManifest(name, ver);
  return link;
}

function placeBinary(name, srcBin, ver) {
  if (!fs.existsSync(srcBin)) throw new Error(`source binary missing: ${srcBin}`);
  fs.mkdirSync(LOCAL_BIN, { recursive: true });
  const dst = versionedFor(name, ver);
  fs.copyFileSync(srcBin, dst);
  if (!IS_WIN) {
    fs.chmodSync(dst, 0o755);
    // mac: npm 包里的二进制完全未签名(codesign: "not signed at all")。Apple Silicon
    // 会直接 SIGKILL 未签名可执行文件(Killed: 9)。落地后 ad-hoc 自签(`-s -`,无需证书)
    // + 去掉可能的 quarantine,Intel/arm64 都能跑。失败不致命(Intel 未签名也能跑)。
    if (process.platform === "darwin") {
      try { execFileSync("codesign", ["-s", "-", "--force", dst], { stdio: "ignore", timeout: 30000 }); } catch {}
      try { execFileSync("xattr", ["-d", "com.apple.quarantine", dst], { stdio: "ignore" }); } catch {}
    }
  }
  linkTo(name, dst, ver);
  return { exe: linkFor(name), target: dst, version: ver };
}

// The bundled per-platform subpackage shipped inside cicy-desktop (zero network).
function bundledPkgDir(name) {
  const pkg = pkgFor(name);
  const candidates = [
    path.join(__dirname, "..", "..", "node_modules", pkg),         // npm install layout
    path.join(process.resourcesPath || "", "runtime-pkgs", pkg),   // packaged (NSIS/dmg) layout
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(path.join(p, "package.json"))) return p; } catch {}
  }
  return null;
}
function bundledVersion(name) {
  const dir = bundledPkgDir(name);
  if (!dir) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || null; } catch { return null; }
}

// Install/upgrade the binary from the bundled subpackage (zero network). Returns
// {exe,version} or null when not bundled. Reuses the existing link when it is
// already at the bundle version or newer (有就不装).
function fromBundle(name = DEFAULT) {
  const dir = bundledPkgDir(name);
  if (!dir) return null;
  const ver = bundledVersion(name);
  if (!ver) return null;
  const src = path.join(dir, binFor(name));
  if (!fs.existsSync(src)) return null;
  const cur = currentVersion(name);
  if (cur && currentLink(name) && cmpVer(cur, ver) >= 0) return { exe: linkFor(name), version: cur };
  if (fs.existsSync(versionedFor(name, ver))) { linkTo(name, versionedFor(name, ver), ver); return { exe: linkFor(name), version: ver }; }
  return placeBinary(name, src, ver);
}

// Download <pkg>@<ver> via `npm pack` and install it into ~/.local/bin. npm is
// ONLY the download channel — we copy the binary out and run it from ~/.local/bin.
// No-op download when that version is already on disk (不重复下载).
async function fetchToLocalBin(ver, { emit, name = DEFAULT } = {}) {
  const e = emit || (() => {});
  if (fs.existsSync(versionedFor(name, ver))) { linkTo(name, versionedFor(name, ver), ver); return { exe: linkFor(name), version: ver }; }
  const label = comp(name).base;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-lb-"));
  try {
    e({ phase: "download", status: "running", message: t("sidecar.downloading", { label, ver }) });
    let out, lastErr;
    for (const reg of await registries()) {
      try { out = await npmExec(["pack", `${pkgFor(name)}@${ver}`, `--registry=${reg}`, "--pack-destination", tmp]); break; }
      catch (e2) { lastErr = e2; }
    }
    if (!out) throw lastErr || new Error(`pack ${pkgFor(name)}@${ver}: all registries failed`);
    const tgz = path.join(tmp, out.trim().split("\n").pop().trim());
    await new Promise((resolve, reject) =>
      execFile("tar", ["-xzf", tgz, "-C", tmp], { windowsHide: true, timeout: 120000 }, (err) => (err ? reject(err) : resolve())));
    const res = placeBinary(name, path.join(tmp, "package", binFor(name)), ver);
    e({ phase: "download", status: "done", message: t("sidecar.ready", { label, ver }) });
    return res;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ~/.local/bin/<base>, if it exists.
function currentLink(name = DEFAULT) {
  return fs.existsSync(linkFor(name)) ? linkFor(name) : null;
}

// Ensure ~/.local/bin/<base> exists and points at a usable binary, version-aware
// and network-frugal:
//   - present & no newer bundle → reuse as-is (有就不装, zero network)
//   - present & bundle is newer → re-seed from the bundle (zero network upgrade)
//   - pinned version            → reuse if already that version, else fetch it
//   - absent                    → seed from the bundle, else fetch latest from npm
async function ensure({ name = DEFAULT, version = null, force = false, emit = null } = {}) {
  const pin = version && version !== "latest" ? version : null;

  if (pin) {
    const cur = currentVersion(name);
    if (!force && cur && cmpVer(cur, pin) === 0) return { exe: linkFor(name), version: cur };
    if (fs.existsSync(versionedFor(name, pin))) { linkTo(name, versionedFor(name, pin), pin); return { exe: linkFor(name), version: pin }; }
    return fetchToLocalBin(pin, { emit, name });
  }

  if (!force && currentLink(name)) {
    // Present — only touch it if the bundle ships something newer (zero network).
    const cur = currentVersion(name);
    const bv = bundledVersion(name);
    if (bv && (!cur || cmpVer(bv, cur) > 0)) {
      const b = fromBundle(name);
      if (b) return b;
    }
    return { exe: linkFor(name), version: cur };
  }

  // Absent (or forced): prefer the zero-network bundle seed, else npm latest.
  const b = fromBundle(name);
  if (b) return b;
  const ver = await latestVersion(name);
  return fetchToLocalBin(ver, { emit, name });
}

// On-demand update from the registry (the 更新 button). Fetches the latest only
// when the registry is actually ahead of what's installed (不重复下载/更新).
async function update({ name = DEFAULT, emit } = {}) {
  const e = emit || (() => {});
  const cur = currentVersion(name);
  const latest = await latestVersion(name);
  if (!latest) throw new Error("无法获取最新版本号");
  if (cur && cmpVer(latest, cur) <= 0) {
    e({ phase: "done", status: "done", message: t("sidecar.upToDateVer", { ver: cur }) });
    return { exe: linkFor(name), version: cur, updated: false };
  }
  const res = await fetchToLocalBin(latest, { emit, name });
  return { ...res, updated: true };
}

module.exports = {
  LOCAL_BIN, LINK, BIN, COMPONENTS, plat,
  pkgFor, binFor, linkFor, versionedFor, versioned,
  cmpVer, currentVersion, latestVersion,
  fromBundle, bundledVersion, fetchToLocalBin, currentLink, ensure, update,
};
