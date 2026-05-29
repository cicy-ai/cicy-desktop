// cicy-code installer — downloads the sidecar binary into ~/.local/bin/,
// with CN-network awareness and double-source retry.
//
// Public surface:
//   getStatus() → { userInstalled, userVersion, binaryPath, installing }
//   checkLatest() → { ok, latest, network, releaseUrl }
//   install({ onProgress, signal }) → final state event
//   cancel() → cancels the in-flight install
//
// Layout on disk (2026-05-29 — versioned + symlink):
//   ~/.local/bin/cicy-code-<version>   actual binary, +x
//   ~/.local/bin/cicy-code             symlink → cicy-code-<version>
//
// The current version is read by `fs.readlink(~/.local/bin/cicy-code)` and
// parsing the basename — no separate version file. Upgrading is "drop
// cicy-code-<newver> + atomic-rename a new symlink over the old one".
// Old versions stay on disk for rollback; future GC may trim them.
//
// Windows path is unchanged — the daemon lives inside WSL2 at
// `$HOME/.local/bin/cicy-code` from the distro's POV, and a separate
// `<userData>/cicy-code/wsl-version` cache mirrors the version for fast
// Windows-side reads.
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
  if (process.platform === "win32") return null; // WSL-managed
  return path.join(require("os").homedir(), ".local", "bin");
}
function userBinary() {
  // Windows: cicy-code lives inside WSL at $HOME/.local/bin/cicy-code, which
  // is not directly addressable from the Windows side. Return a virtual
  // marker path so callers can still test "is something installed?" — actual
  // existence is checked via wsl.userInstalled() in cicy-code.js.
  if (process.platform === "win32") return "wsl:cicy-code";

  const dir = userDir();
  if (!dir) return null;
  // ~/.local/bin/cicy-code — symlink to the active version on disk.
  return path.join(dir, "cicy-code");
}
// Resolve the versioned binary path for a given semver string.
function versionedBinaryPath(version) {
  const dir = userDir();
  if (!dir || !version) return null;
  return path.join(dir, `cicy-code-${version}`);
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
  const bin = userBinary();
  if (!bin) return null;
  // Preferred: read the symlink target and parse `cicy-code-<version>`.
  try {
    const target = fs.readlinkSync(bin);
    const m = path.basename(target).match(/^cicy-code-(\d+\.\d+\.\d+)$/);
    if (m) return m[1];
  } catch {}
  // Fallback: if some legacy install wrote a `version` file next to the
  // binary, honour it. Lets older installs upgrade cleanly.
  try {
    const legacy = path.join(path.dirname(bin), "version");
    const v = fs.readFileSync(legacy, "utf8").trim();
    if (/^\d+\.\d+\.\d+$/.test(v)) return v;
  } catch {}
  return null;
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

// Quick "is the daemon listening on :8008?" probe used by the homepage to
// decide between showing a "Start" or an "Open" button on the local card.
// Returns true on any 2xx/3xx/4xx response — we just want to know that
// something is binding the port and answering HTTP.
function isRunning(port = 8008) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "HEAD", timeout: 1500 },
      (res) => { res.resume(); resolve(true); }
    );
    req.on("error",   () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
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
              // On macOS/Linux the old binary may still be running.
              // rename() over a running binary replaces the dir entry but
              // the running process keeps the old inode — safe. However
              // some systems raise ETXTBSY. Unlinking the old file first
              // ensures we always get a fresh inode.
              try { fs.unlinkSync(destPath); } catch {}
              try {
                fs.renameSync(tmp, destPath);
              } catch {
                // Last resort: copy bytes (works even if rename fails across
                // filesystems or when the old file is still locked).
                fs.copyFileSync(tmp, destPath);
                try { fs.unlinkSync(tmp); } catch {}
              }
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

    // The manifest can be uploaded before the binary asset on GitHub
    // Releases (Actions uploads files sequentially). Verify the binary
    // is actually reachable before declaring this version "available" —
    // otherwise an "update available" indicator points at a 404.
    const network = await netDetect.detect();
    const probeUrls = buildUrlList(assetUrl, network);
    const reachable = await new Promise((resolve) => {
      let pending = probeUrls.length;
      let done = false;
      probeUrls.forEach((u) =>
        headCheck(u, { timeoutMs: 5000 }).then((ok) => {
          if (ok && !done) { done = true; resolve(true); }
          if (--pending === 0 && !done) resolve(false);
        })
      );
    });
    if (!reachable) {
      log.warn(`[installer] manifest v${m.version} present but binary asset not reachable yet`);
      throw new Error(`RELEASE_NOT_READY:${m.version}`);
    }
    return {
      version: m.version,
      htmlUrl: `https://github.com/${REPO}/releases/tag/v${m.version}`,
      archAlias,
      assetUrl,
      sizeBytes: (m.sizes && m.sizes[key]) || null,
    };
  } catch (manifestErr) {
    // RELEASE_NOT_READY is a real signal — propagate to caller so the UI
    // can show "wait a few minutes" instead of fallback-probing.
    if (/^RELEASE_NOT_READY:/.test(manifestErr.message)) throw manifestErr;
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

// ---- parallel race download ----
// Race a list of URLs in parallel — whichever responds first wins. Each
// candidate writes to its own .partN temp file; on success, the winner is
// atomically moved (or copied) to dest and losers are cancelled and cleaned up.
//
// emit:        coarse phase events (per-attempt "downloading" announcement)
// emitProgress: throttled byte-level progress updates
// outerSignal: external cancel — checked after the race resolves
async function raceDownload({ urls, dest, version, network, emit, emitProgress, outerSignal }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr;

  await new Promise((resolve, reject) => {
    let settled = false;
    let pending = urls.length;

    const settle = (winner) => {
      if (settled) return;
      settled = true;
      resolve(winner);
      controllers.forEach(c => { try { c.abort(); } catch {} });
    };
    const fail = (err) => {
      lastErr = err;
      if (--pending === 0 && !settled) reject(lastErr);
    };

    const controllers = urls.map((url, i) => {
      const ctl = new AbortController();
      const tmpPath = dest + `.part${i}`;
      const { MIRRORS } = require("./mirrors");
      const isMirror = MIRRORS.some(m => url.startsWith(m.url));
      emit({ phase: "downloading", message: "并行下载中…", version, network, progress: 0 });
      downloadFile(url, tmpPath, {
        signal: ctl.signal,
        timeoutMs: 60000,
        onProgress: ({ received, total }) => {
          if (settled) return;
          const pct = total ? received / total : null;
          emitProgress({ phase: "downloading", message: `下载中 (${isMirror ? "镜像" : "直连"})`, progress: pct, version, network, received, total });
        },
      }).then(({ destPath }) => {
        if (settled) { try { fs.unlinkSync(destPath); } catch {} return; }
        try { fs.unlinkSync(dest); } catch {}
        try {
          fs.renameSync(destPath, dest);
        } catch {
          fs.copyFileSync(destPath, dest);
          try { fs.unlinkSync(destPath); } catch {}
        }
        settle(url);
      }).catch(err => {
        if (err.message !== "cancelled") fail(err);
        try { fs.unlinkSync(tmpPath); } catch {}
      });
      return ctl;
    });
  });

  if (outerSignal && outerSignal.aborted) throw new Error("cancelled");
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

  // Throttled progress emitter — max 1 update per 80ms to prevent
  // rapid parallel-download events from causing UI flicker.
  let pendingProg = null;
  let progTimer = null;
  const emitProgress = (event) => {
    pendingProg = event;
    if (!progTimer) {
      progTimer = setTimeout(() => {
        progTimer = null;
        if (pendingProg) {
          emit(pendingProg);
          pendingProg = null;
        }
      }, 80);
    }
  };

  try {
    emit({ phase: "detecting", message: "检测网络…" });
    const network = await netDetect.detect();

    emit({ phase: "checking", message: "检查最新版本…", network });
    const check = await checkLatest();
    if (!check.ok) throw new Error(check.error);

    if (check.installedVersion === check.latest) {
      const bin = userBinary();
      const binaryExists = bin && bin !== "wsl:cicy-code" && fs.existsSync(bin);
      if (binaryExists) {
        const ev = { phase: "done", message: `已是最新版本 v${check.latest}`, version: check.latest, network, alreadyUpToDate: true };
        emit(ev);
        return ev;
      }
      // version file says up-to-date but binary is missing — re-download
      log.info(`[installer] version=${check.latest} but binary missing, re-downloading`);
    }

    // ── Windows: download on host (parallel race + progress + verify),
    // then hand the file to WSL. setupAll() also handles WSL/Ubuntu install
    // if needed, fully automatic with CN-aware mirrors. Network detection is
    // already done; we pass it through so wsl.installWsl picks --web-download
    // first when in CN (avoids slow Microsoft Store).
    if (process.platform === "win32") {
      const wsl = require("./wsl");

      // Stage to userData/cicy-code/wsl-stage. Path is accessible from WSL
      // via /mnt/c/... (translated by wslpath in installFromHostFile).
      const stageDir = path.join(app.getPath("userData"), "cicy-code", "wsl-stage");
      const stagePath = path.join(stageDir, "cicy-code-staged");

      emit({ phase: "downloading", message: `下载 cicy-code v${check.latest}…`, version: check.latest, network, progress: 0 });
      const order = buildUrlList(check.assetUrl, network);
      await raceDownload({
        urls: order,
        dest: stagePath,
        version: check.latest,
        network,
        emit,
        emitProgress,
        outerSignal: ac.signal,
      });

      // setupAll handles the rest: install WSL+Ubuntu if needed, then
      // copy the staged binary into the distro. Each step streams progress.
      const result = await wsl.setupAll({
        network,
        hostStagePath: stagePath,
        version: check.latest,
        onProgress: emit,
      });
      const installedVersion = result.version || check.latest;
      if (installedVersion !== check.latest) {
        log.warn(`[installer] WSL binary reports v${installedVersion}, expected v${check.latest} — mirror likely cached stale content`);
      }

      // Cache version on Windows side so userVersion() doesn't need WSL.
      try {
        const cacheDir = path.join(app.getPath("userData"), "cicy-code");
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, "wsl-version"), installedVersion, "utf8");
      } catch {}

      try { fs.unlinkSync(stagePath); } catch {}

      const final = { phase: "done", message: `已安装 v${installedVersion}`, version: installedVersion, network };
      emit(final);
      return final;
    }

    emit({ phase: "downloading", message: `下载 cicy-code v${check.latest}…`, version: check.latest, network, progress: 0 });

    const order = buildUrlList(check.assetUrl, network);
    // Download straight to ~/.local/bin/cicy-code-<assumed version>. We re-
    // verify the version after by execing --version; if the mirror served a
    // stale binary the file may end up renamed.
    let dest = versionedBinaryPath(check.latest);
    if (!dest) throw new Error(`unsupported platform ${process.platform}-${process.arch}`);

    await raceDownload({
      urls: order,
      dest,
      version: check.latest,
      network,
      emit,
      emitProgress,
      outerSignal: ac.signal,
    });

    emit({ phase: "installing", message: "正在安装…", version: check.latest, network, progress: 1 });

    try { fs.chmodSync(dest, 0o755); } catch (e) { log.warn(`[installer] chmod failed: ${e.message}`); }

    // Verify the downloaded binary reports the expected version. Mirrors
    // sometimes serve stale cached content. If `--version` disagrees, rename
    // the file onto the real version so the symlink we point at is honest.
    let installedVersion = check.latest;
    try {
      const { execFileSync } = require("child_process");
      const out = execFileSync(dest, ["--version"], { timeout: 5000, encoding: "utf8" }).trim();
      const m = out.match(/(\d+\.\d+\.\d+)/);
      if (m && m[1] !== check.latest) {
        log.warn(`[installer] downloaded binary reports v${m[1]}, expected v${check.latest} — mirror likely cached stale content`);
        const realDest = versionedBinaryPath(m[1]);
        if (realDest && realDest !== dest) {
          try { fs.unlinkSync(realDest); } catch {}
          fs.renameSync(dest, realDest);
          dest = realDest;
        }
        installedVersion = m[1];
      }
    } catch (e) {
      log.warn(`[installer] version verify failed: ${e.message}`);
    }

    // Atomic-replace the `cicy-code` symlink to point at the new versioned
    // binary. Write the new link at a tmp name + rename = atomic on POSIX,
    // so a concurrent reader either sees the old version or the new one,
    // never a missing file.
    const link = userBinary();                        // ~/.local/bin/cicy-code
    const linkDir = path.dirname(link);
    fs.mkdirSync(linkDir, { recursive: true });
    const tmpLink = `${link}.new-${process.pid}-${Date.now()}`;
    try { fs.unlinkSync(tmpLink); } catch {}
    fs.symlinkSync(path.basename(dest), tmpLink);     // relative → cicy-code-<ver>
    fs.renameSync(tmpLink, link);

    log.info(`[installer] linked ~/.local/bin/cicy-code → cicy-code-${installedVersion}`);
    const final = { phase: "done", message: `已安装 v${installedVersion}`, version: installedVersion, network };
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
  isRunning,
  checkLatest,
  install,
  cancel,
  userBinary,
  userVersion,
};
