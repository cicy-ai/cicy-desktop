// ~/.local/bin install model for the cicy-code daemon binary.
//
// 主人指令 (2026-06): cicy-desktop OWNS the binary. It is bundled per-platform
// (an optionalDependency of cicy-desktop). On first run we copy the bundled,
// version-named binary into ~/.local/bin/cicy-code-<ver>-<plat> and point
// ~/.local/bin/cicy-code at it (symlink on mac/linux; a plain COPY on Windows —
// symlink/junction perms there are a minefield). The daemon is ALWAYS run from
// that stable ~/.local/bin/cicy-code path — never `npx cicy-code`, which would
// reuse a stale globally-installed copy and shadow updates.
//
// Updates use npm ONLY as a download channel: `npm pack` the per-platform
// subpackage (sha512-verified), extract the binary, copy it in as a NEW
// version-named file, then re-point the cicy-code link (re-copy on Windows).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const IS_WIN = process.platform === "win32";
const REGISTRY = process.env.CICY_NPM_REGISTRY || "https://registry.npmmirror.com";
const LOCAL_BIN = path.join(os.homedir(), ".local", "bin");

function plat() {
  const osStr = IS_WIN ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${osStr}-${arch}`;
}
const PKG = () => `cicy-code-${plat()}`;
const BIN = IS_WIN ? "cicy-code.exe" : "cicy-code";
const LINK = path.join(LOCAL_BIN, IS_WIN ? "cicy-code.exe" : "cicy-code");
const versioned = (ver) => path.join(LOCAL_BIN, `cicy-code-${ver}-${plat()}${IS_WIN ? ".exe" : ""}`);

function npmExec(args, timeout = 600000) {
  return new Promise((resolve, reject) => {
    execFile("npm", args, { windowsHide: true, timeout, shell: IS_WIN }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve(String(stdout)));
  });
}

// Latest published version of the per-platform subpackage.
async function latestVersion() {
  return (await npmExec(["view", PKG(), "version", `--registry=${REGISTRY}`], 30000)).trim();
}

// Point ~/.local/bin/cicy-code at a version-named binary: symlink on POSIX, a
// plain copy on Windows.
function linkTo(verBinPath) {
  fs.mkdirSync(LOCAL_BIN, { recursive: true });
  try { fs.rmSync(LINK, { force: true }); } catch {}
  if (IS_WIN) {
    fs.copyFileSync(verBinPath, LINK);
  } else {
    fs.symlinkSync(verBinPath, LINK);
  }
  return LINK;
}

function placeBinary(srcBin, ver) {
  if (!fs.existsSync(srcBin)) throw new Error(`source binary missing: ${srcBin}`);
  fs.mkdirSync(LOCAL_BIN, { recursive: true });
  const dst = versioned(ver);
  fs.copyFileSync(srcBin, dst);
  if (!IS_WIN) fs.chmodSync(dst, 0o755);
  linkTo(dst);
  return { exe: LINK, target: dst, version: ver };
}

// The bundled per-platform subpackage shipped inside cicy-desktop (zero network).
function bundledPkgDir() {
  const candidates = [
    path.join(__dirname, "..", "..", "node_modules", PKG()),         // npm install layout
    path.join(process.resourcesPath || "", "runtime-pkgs", PKG()),   // packaged (NSIS/dmg) layout
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(path.join(p, "package.json"))) return p; } catch {}
  }
  return null;
}

// Install the binary from the bundled subpackage. null when not bundled.
function fromBundle() {
  const dir = bundledPkgDir();
  if (!dir) return null;
  let ver;
  try { ver = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version; } catch { return null; }
  const src = path.join(dir, BIN);
  if (!fs.existsSync(src)) return null;
  if (fs.existsSync(versioned(ver))) { linkTo(versioned(ver)); return { exe: LINK, version: ver }; }
  return placeBinary(src, ver);
}

// Download <pkg>@<ver> via `npm pack` and install it into ~/.local/bin. npm is
// ONLY the download channel — we copy the binary out and run it from ~/.local/bin.
async function fetchToLocalBin(ver, { emit } = {}) {
  const e = emit || (() => {});
  if (fs.existsSync(versioned(ver))) { linkTo(versioned(ver)); return { exe: LINK, version: ver }; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-cc-"));
  try {
    e({ phase: "download", status: "running", message: `下载 cicy-code ${ver}…` });
    const out = await npmExec(["pack", `${PKG()}@${ver}`, `--registry=${REGISTRY}`, "--pack-destination", tmp]);
    const tgz = path.join(tmp, out.trim().split("\n").pop().trim());
    await new Promise((resolve, reject) =>
      execFile("tar", ["-xzf", tgz, "-C", tmp], { windowsHide: true, timeout: 120000 }, (err) => (err ? reject(err) : resolve())));
    const res = placeBinary(path.join(tmp, "package", BIN), ver);
    e({ phase: "download", status: "done", message: `cicy-code ${ver} 就绪` });
    return res;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ~/.local/bin/cicy-code, if it exists.
function currentLink() {
  return fs.existsSync(LINK) ? LINK : null;
}

// Ensure ~/.local/bin/cicy-code exists and points at a usable binary.
//   - already linked → reuse (unless force)
//   - else bundled subpackage (zero network, the "pre-installed" path)
//   - else download latest (or a pinned version) via npm
async function ensure({ version = null, force = false, emit = null } = {}) {
  if (!force && currentLink()) return { exe: LINK };
  const pin = version && version !== "latest" ? version : null;
  if (!force && !pin) {
    const b = fromBundle();
    if (b) return b;
  }
  const ver = pin || (await latestVersion());
  return fetchToLocalBin(ver, { emit });
}

module.exports = { LOCAL_BIN, LINK, plat, versioned, latestVersion, fromBundle, fetchToLocalBin, currentLink, ensure };
