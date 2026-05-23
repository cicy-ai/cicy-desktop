// cicy-code installer — downloads the sidecar binary into the user-data
// directory, with CN-network awareness and double-source retry.
//
// Public surface:
//   getStatus() → { userInstalled, userVersion, binaryPath, installing }
//   checkLatest() → { ok, latest, network, releaseUrl }
//   install({ onProgress, signal }) → final state event
//   cancel() → cancels the in-flight install
//
// Layout on disk:
//   <userData>/cicy-code/<platform>-<arch>/cicy-code   (binary, +x)
//   <userData>/cicy-code/<platform>-<arch>/version     (plain text)
//
// Progress event shape:
//   { phase, message, progress?, version?, network?, error? }
//   phase ∈ "detecting" | "checking" | "downloading" | "installing" | "done" | "error" | "cancelled"

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { app } = require("electron");
const log = require("electron-log");
const netDetect = require("./net-detect");
const { buildUrlList } = require("./mirrors");

const REPO = "cicy-ai/cicy-code";

// Arch aliases — release artifacts often use Go's "amd64" while Node's
// process.arch reports "x64".
const ARCH_ALIASES = {
  x64:   ["x64", "amd64", "x86_64"],
  arm64: ["arm64", "aarch64"],
};

// ---- platform helpers ----
// On Windows we run the linux-amd64 binary inside WSL2, so platformDir()
// reports "linux" for win32 — the manifest lookup, asset URL construction,
// and arch alias logic all just use the Linux entry. wsl.js owns actually
// putting the binary onto disk inside the distro.
function platformDir() {
  return process.platform === "darwin" ? "darwin"
       : process.platform === "linux"  ? "linux"
       : process.platform === "win32"  ? "linux"
       : null;
}
function archDir() {
  // On Windows we always pull linux-amd64 (WSL distros are typically x64).
  if (process.platform === "win32") return "x64";
  return process.arch === "x64"   ? "x64"
       : process.arch === "arm64" ? "arm64"
       : null;
}
function userDir() {
  const p = platformDir(), a = archDir();
  if (!p || !a) return null;
  return path.join(app.getPath("userData"), "cicy-code", `${p}-${a}`);
}
function userBinary() {
  // Windows: cicy-code lives inside WSL at $HOME/.local/bin/cicy-code, which
  // is not directly addressable from the Windows side. Return a virtual
  // marker path so callers can still test "is something installed?" — actual
  // existence is checked via wsl.userInstalled() in cicy-code.js.
  if (process.platform === "win32") return "wsl:cicy-code";
  const dir = userDir();
  if (!dir) return null;
  return path.join(dir, "cicy-code");
}
function userVersion() {
  if (process.platform === "win32") {
    // sync read of version file from inside WSL is awkward; we rely on the
    // installer step to mirror the version into a Windows-side cache.
    try {
      const cache = path.join(app.getPath("userData"), "cicy-code", "wsl-version");
      return fs.readFileSync(cache, "utf8").trim() || null;
    } catch { return null; }
  }
  const dir = userDir();
  if (!dir) return null;
  try { return fs.readFileSync(path.join(dir, "version"), "utf8").trim() || null; }
  catch { return null; }
}

// ---- state ----
let inflight = null;        // { abort: () => void }
let lastProgress = null;    // last emitted event (for late subscribers)

function getStatus() {
  // win32: binaryPath is a virtual marker; actual existence is inside WSL.
  // We can't call wsl.userInstalled() synchronously here, so we rely on the
  // cached wsl-version file: if it exists the user already completed an
  // install. The sidecar:status IPC also has a dedicated sidecar:wsl-status
  // channel for deeper probing.
  const bin    = userBinary();
  const ver    = userVersion();
  const installed = process.platform === "win32"
    ? !!ver   // win32: treat "has version cache" as installed
    : !!(bin && fs.existsSync(bin));
  return {
    userInstalled: installed,
    userVersion:   ver,
    binaryPath:    bin,
    installing:    !!inflight,
    lastProgress,
  };
}

// ---- HTTP helpers ----
function headCheck(url, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https:") ? https : http;
    const tryUrl = (u, hops = 0) => {
      if (hops > 5) return resolve(false);
      const req = lib.request(u, { method: "HEAD", timeout: timeoutMs }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return tryUrl(res.headers.location, hops + 1);
        }
        res.resume();
        // 200 = exists, 403/404 = not found / blocked. Some mirrors return 200 for HEAD even when GET would 404 — best effort.
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    };
    tryUrl(url);
  });
}

function getJson(url, { timeoutMs = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { "User-Agent": "cicy-desktop", ...headers } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        return getJson(res.headers.location, { timeoutMs, headers }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function downloadFile(url, destPath, { signal, onProgress, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmp = destPath + ".part";
    let out;
    let aborted = false;
    let req;

    const cleanup = () => {
      if (out) try { out.close(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
    };
    const onAbort = () => {
      aborted = true;
      if (req) try { req.destroy(); } catch {}
      cleanup();
      reject(new Error("cancelled"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const start = (currentUrl) => {
      const lib = currentUrl.startsWith("https:") ? https : http;
      req = lib.get(currentUrl, { timeout: timeoutMs }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return start(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          cleanup();
          return reject(new Error(`HTTP ${res.statusCode} ${currentUrl}`));
        }
        const total = Number(res.headers["content-length"]) || 0;
        let received = 0;
        out = fs.createWriteStream(tmp);
        res.on("data", (chunk) => {
          if (aborted) return;
          received += chunk.length;
          if (onProgress) {
            try { onProgress({ received, total }); } catch {}
          }
        });
        res.pipe(out);
        out.on("finish", () => {
          if (aborted) return;
          out.close((closeErr) => {
            if (closeErr) return reject(closeErr);
            try {
              fs.renameSync(tmp, destPath);
              resolve({ destPath, total });
            } catch (e) { reject(e); }
          });
        });
        out.on("error", (e) => { cleanup(); reject(e); });
      });
      req.on("error", (e) => { cleanup(); reject(e); });
      req.on("timeout", () => { req.destroy(); cleanup(); reject(new Error("timeout")); });
    };
    start(url);
  });
}

// ---- release lookup ----
// `manifest.json` is published as a release asset by .github/workflows/release.yml.
// GitHub's `releases/latest/download/<asset>` redirect always resolves to the
// most recent release, so we get a stable URL for "the latest manifest" without
// hitting api.github.com (which is blocked in CN).
//
// Each request is parallel-raced across direct + CN_MIRRORS so whichever path
// is fastest wins. Short timeout so we don't hang the UI when a mirror dies.
const MANIFEST_PATH = `${REPO}/releases/latest/download/manifest.json`;
const MANIFEST_DIRECT = `https://github.com/${MANIFEST_PATH}`;

async function fetchManifest() {
  const network = await netDetect.detect();
  const urls = buildUrlList(MANIFEST_DIRECT, network);
  return new Promise((resolve, reject) => {
    let done = 0;
    let lastErr;
    let resolved = false;
    urls.forEach(u => {
      getJson(u, { timeoutMs: 4000 }).then(j => {
        if (resolved) return;
        if (j && j.version && j.assets) {
          resolved = true;
          log.info(`[installer] manifest from ${u.startsWith("https://github.com/") ? "direct" : "mirror"} → v${j.version}`);
          resolve(j);
        } else if (++done === urls.length && !resolved) {
          reject(lastErr || new Error("manifest had no version field"));
        }
      }).catch(e => {
        lastErr = e;
        if (++done === urls.length && !resolved) reject(lastErr);
      });
    });
  });
}

async function fetchLatestReleaseSmart() {
  const archAlias = pickArchAlias();
  if (!archAlias) throw new Error(`unsupported arch ${process.arch}`);
  const plat = platformDir();
  const key  = `${plat}-${archAlias}`;
  try {
    const m = await fetchManifest();
    const assetUrl = m.assets && m.assets[key];
    if (!assetUrl) throw new Error(`no asset for ${key} in manifest`);
    return {
      version: m.version,
      htmlUrl: `https://github.com/${REPO}/releases/tag/v${m.version}`,
      archAlias,
      assetUrl,
      sizeBytes: (m.sizes && m.sizes[key]) || null,
    };
  } catch (manifestErr) {
    // Fallback path: older releases (before manifest.json existed) still use
    // jsdelivr tag list + HEAD probe. Will be removed once all live releases
    // ship a manifest.json.
    log.warn(`[installer] manifest fetch failed (${manifestErr.message}), falling back to jsdelivr probe`);
    return fetchLatestReleaseLegacy();
  }
}

const JSDELIVR_DATA_URL = `https://data.jsdelivr.com/v1/package/gh/${REPO}`;
async function fetchLatestReleaseLegacy() {
  const meta = await getJson(JSDELIVR_DATA_URL, { timeoutMs: 5000 });
  const versions = meta.versions || [];
  if (versions.length === 0) throw new Error("no versions in jsdelivr response");
  const network = await netDetect.detect();
  const archAlias = pickArchAlias();
  const plat = platformDir();
  for (const version of versions.slice(0, 6)) {
    const directUrl = `https://github.com/${REPO}/releases/download/v${version}/cicy-code-${plat}-${archAlias}`;
    const probeOrder = buildUrlList(directUrl, network);
    log.info(`[installer] probing v${version} (legacy, network=${network})`);
    const found = await new Promise(resolve => {
      let done = 0;
      probeOrder.forEach(u => headCheck(u, { timeoutMs: 3000 }).then(ok => {
        if (ok && !done) resolve(u);
        if (++done === probeOrder.length) resolve(null);
      }));
    });
    if (found) return {
      version,
      htmlUrl: `https://github.com/${REPO}/releases/tag/v${version}`,
      archAlias,
      assetUrl: directUrl,
      sizeBytes: null,
    };
  }
  throw new Error(`no release binary found for ${plat}-${archAlias} in recent versions`);
}

function pickArchAlias() {
  const arch = archDir();
  if (!arch) return null;
  const aliases = ARCH_ALIASES[arch] || [arch];
  // First alias is the canonical one for our naming convention.
  // Prefer Go-style amd64 over x64 since release names use it.
  const preferred = arch === "x64" ? "amd64" : aliases[0];
  return preferred;
}

async function checkLatest() {
  try {
    const release = await fetchLatestReleaseSmart();
    if (!release.version) return { ok: false, error: "no version found" };
    const network = await netDetect.detect();
    return {
      ok: true,
      latest: release.version,
      assetName: `cicy-code-${platformDir()}-${release.archAlias}`,
      assetUrl: release.assetUrl,
      sizeBytes: release.sizeBytes,    // populated when manifest.json available
      network,
      releaseUrl: release.htmlUrl,
      installedVersion: userVersion(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- install ----
async function install({ onProgress } = {}) {
  if (inflight) throw new Error("install already in progress");

  const ac = new AbortController();
  inflight = { abort: () => ac.abort() };

  const emit = (event) => {
    lastProgress = event;
    if (onProgress) {
      try { onProgress(event); } catch {}
    }
  };

  try {
    emit({ phase: "detecting", message: "检测网络…" });
    const network = await netDetect.detect();

    emit({ phase: "checking", message: "检查最新版本…", network });
    const check = await checkLatest();
    if (!check.ok) throw new Error(check.error);

    if (check.installedVersion === check.latest) {
      const ev = { phase: "done", message: `已是最新版本 v${check.latest}`, version: check.latest, network, alreadyUpToDate: true };
      emit(ev);
      return ev;
    }

    // ── Windows: install via WSL (linux-amd64 binary inside the distro) ──
    if (process.platform === "win32") {
      const wsl = require("./wsl");
      const status = await wsl.checkStatus();
      if (!status.installed)  throw new Error("WSL 未安装。请在管理员 PowerShell 运行: wsl --install -d Ubuntu");
      if (!status.hasDistro)  throw new Error("WSL 未配置发行版。请运行: wsl --install -d Ubuntu");
      emit({ phase: "downloading", message: `在 WSL (${status.distro}) 内下载 v${check.latest}…`, version: check.latest, network });
      await wsl.installCicyCode({
        version: check.latest,
        assetUrl: check.assetUrl,
        network,
        onProgress: emit,
      });
      // Mirror the version into a Windows-side cache so userVersion() can
      // read it without shelling into WSL on every call.
      try {
        const cacheDir = path.join(app.getPath("userData"), "cicy-code");
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, "wsl-version"), check.latest, "utf8");
      } catch {}
      const final = { phase: "done", message: `已安装 v${check.latest}`, version: check.latest, network };
      emit(final);
      return final;
    }

    emit({ phase: "downloading", message: `下载 cicy-code v${check.latest}…`, version: check.latest, network, progress: 0 });

    // CN: try mirrors before direct (direct often slow/blocked). Global:
    // direct first since mirrors add an unnecessary hop.
    const order = buildUrlList(check.assetUrl, network);

    const dest = userBinary();
    if (!dest) throw new Error(`unsupported platform ${process.platform}-${process.arch}`);

    let lastErr;
    let downloaded = false;
    for (const url of order) {
      const { MIRRORS } = require('./mirrors'); const isMirror = MIRRORS.some(m => url.startsWith(m.url));
      try {
        emit({ phase: "downloading", message: `下载中 (${isMirror ? "镜像" : "直连"})…`, version: check.latest, network, progress: 0 });
        await downloadFile(url, dest, {
          signal: ac.signal,
          onProgress: ({ received, total }) => {
            const pct = total ? received / total : null;
            emit({ phase: "downloading", message: "下载中", progress: pct, version: check.latest, network, received, total });
          },
        });
        downloaded = true;
        break;
      } catch (e) {
        if (e.message === "cancelled") throw e;
        lastErr = e;
        log.warn(`[installer] download via ${url} failed: ${e.message}`);
      }
    }
    if (!downloaded) throw lastErr || new Error("all download sources failed");

    emit({ phase: "installing", message: "正在安装…", version: check.latest, network, progress: 1 });

    if (process.platform !== "win32") {
      try { fs.chmodSync(dest, 0o755); } catch (e) { log.warn(`[installer] chmod failed: ${e.message}`); }
    }
    try { fs.writeFileSync(path.join(path.dirname(dest), "version"), check.latest, "utf8"); } catch {}

    const final = { phase: "done", message: `已安装 v${check.latest}`, version: check.latest, network };
    emit(final);
    return final;
  } catch (e) {
    const ev = e.message === "cancelled"
      ? { phase: "cancelled", message: "已取消" }
      : { phase: "error", message: `失败: ${e.message}`, error: e.message };
    emit(ev);
    throw e;
  } finally {
    inflight = null;
  }
}

function cancel() {
  if (inflight) inflight.abort();
}

module.exports = {
  getStatus,
  checkLatest,
  install,
  cancel,
  userBinary,
  userVersion,
};
