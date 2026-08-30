// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Windows sidecar backend: run cicy-code inside a Docker container.
//
// Platform split (2026-06): mac/linux start cicy-code locally via `npx
// cicy-code` (see cicy-code.js); Windows runs it in Docker Desktop instead.
// The base-env image's entrypoint installs cicy-code from npm at container
// startup, so the image is version-independent. If the image isn't present
// locally it's loaded from our R2 bucket (no Docker Hub pull):
//   https://r2.deepfetch.de5.net/images/cicy-code-latest.tar.gz
//
// The container maps :8008 and persists ~/cicy-ai in a named volume.
const log = require("electron-log"); // bootstrap preflight failures must land in main.log
const { execFile, execFileSync, spawn } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { classifyWslPrerequisites } = require("./wsl-prerequisites");

const IMAGE     = process.env.CICY_DOCKER_IMAGE || "cicybot/cicy-code:latest";
// Image tarball on Cloudflare R2 (public bucket). The Aliyun OSS mirror it used
// to live on is gone — that account was disabled and the whole bucket returns
// 403 UserDisable. Note the tradeoff recorded when we moved OFF R2 originally:
// OSS served CN at ~13MB/s, R2 was throttled to ~150KB/s from CN. Override via env.
const R2_TARBALL = process.env.CICY_DOCKER_URL  || "https://r2.deepfetch.de5.net/images/cicy-code-latest.tar.gz";
const DL_UA     = process.env.CICY_DL_UA || "cicy-desktop"; // download UA (CN mirrors 403 empty/Mozilla UAs)
const CONTAINER = process.env.CICY_DOCKER_CONTAINER || "cicy-code";
const VOLUME    = process.env.CICY_DOCKER_VOLUME || "cicy-ai-data";
// Docker Desktop installer (Windows). Direct from docker.com, with a COS mirror
// fallback for CN where docker.com is slow/blocked. Override via env if needed.
const DOCKER_DESKTOP_URL = process.env.CICY_DOCKER_DESKTOP_URL
  || "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
const DOCKER_DESKTOP_MIRROR = process.env.CICY_DOCKER_DESKTOP_MIRROR
  || "https://cicy-1372193042.cos.ap-shanghai.myqcloud.com/binaries/DockerDesktopInstaller.exe";
// CICY_* env vars forwarded into the container (team onboarding, version pin…).
const PASS_ENV = [
  "CICY_TEAM_TOKEN", "CICY_CODE_VERSION", "NPM_REGISTRY", "CICY_NPM_REGISTRY",
  "CICY_AGENTS", "ENABLE_CDN", "CICY_CLOUDFLARED_TOKEN",
  "CICY_CLOUD_EMAIL", "CICY_CLOUD_TEAM_ID", "CICY_CFT",
];

// Resolve the docker CLI. CRITICAL on Windows: right after Docker Desktop
// installs, it adds `...\Docker\resources\bin` to the SYSTEM PATH — but the
// ALREADY-RUNNING cicy-desktop process keeps its stale PATH, so a bare
// `execFile("docker", …)` ENOENTs and dockerOk() stays false forever (the
// "已安装但起不来 / 卡在正在启动" bug). Probe the known absolute install paths
// first; only fall back to PATH (and never cache that fallback, so a later
// install is picked up).
let _dockerBin = null;
function dockerBin() {
  if (_dockerBin) return _dockerBin;
  if (process.platform === "win32") {
    const cands = [
      path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe"),
      path.join(process.env["ProgramW6432"] || "", "Docker", "Docker", "resources", "bin", "docker.exe"),
      path.join(process.env["LOCALAPPDATA"] || "", "Docker", "Docker", "resources", "bin", "docker.exe"),
    ].filter((c) => c && !c.startsWith("Docker"));
    for (const c of cands) { try { if (fs.existsSync(c)) { _dockerBin = c; return c; } } catch {} }
  }
  return "docker"; // PATH fallback (mac/linux, or before Docker is installed)
}

function run(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(dockerBin(), args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stdout = String(stdout || ""); err.stderr = String(stderr || ""); return reject(err); }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function dockerOk() {
  try { await run(["version", "--format", "{{.Server.Version}}"], { timeout: 8000 }); return true; }
  catch { return false; }
}

// Docker Desktop installed on disk? (daemon may still be stopped — dockerOk()
// only answers "is the daemon up"). Lets bootstrap start the app instead of
// re-downloading the 500MB installer when it's merely not running.
function dockerDesktopExe() {
  const candidates = [
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
    path.join(process.env["LOCALAPPDATA"] || "", "Docker", "Docker Desktop.exe"),
  ];
  for (const p of candidates) { try { if (p && fs.existsSync(p)) return p; } catch {} }
  return null;
}

function startDockerDesktop() {
  const exe = dockerDesktopExe();
  if (!exe) return false;
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return true;
  } catch { return false; }
}

async function imagePresent() {
  try { await run(["image", "inspect", IMAGE], { timeout: 8000 }); return true; }
  catch { return false; }
}

// Resumable download with byte-level progress. `resume:true` continues a partial
// file via a Range request (so a dropped 226MB pull doesn't restart from 0 — the
// user's "步骤走过的不要再走"). onProgress({received,total}) fires as bytes arrive.
function download(url, dest, { hops = 5, onProgress = null, resume = false } = {}) {
  return new Promise((resolve, reject) => {
    if (hops <= 0) return reject(new Error("too many redirects"));
    let offset = 0;
    if (resume) { try { offset = fs.statSync(dest).size; } catch {} }
    const lib = url.startsWith("https:") ? https : http;
    // A non-empty, non-browser UA is required by some CN mirrors (Tsinghua TUNA
    // 403s an empty UA AND a Mozilla/browser UA — anti-hotlink — but allows a
    // plain client UA like this).
    const headers = { "User-Agent": DL_UA, ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}) };
    const req = lib.get(url, { timeout: 60000, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, { hops: hops - 1, onProgress, resume }).then(resolve, reject);
      }
      // 206 = server honored the Range (append); 200 with offset = server ignored
      // it, so restart from scratch; anything else is an error.
      const partial = res.statusCode === 206;
      if (res.statusCode !== 200 && !partial) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      if (!partial) offset = 0;
      const total = (Number(res.headers["content-length"]) || 0) + offset;
      let received = offset;
      const out = fs.createWriteStream(dest, { flags: partial ? "a" : "w" });
      res.on("data", (c) => {
        received += c.length;
        if (onProgress) { try { onProgress({ received, total }); } catch {} }
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(dest)));
      out.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Retry an async op N times with backoff. Each attempt is announced so a flaky
// network shows "重试中 (2/4)" rather than silently hanging.
async function withRetry(fn, { tries = 4, baseDelayMs = 3000, onAttempt = null } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(i); }
    catch (e) {
      lastErr = e;
      if (onAttempt) { try { onAttempt({ attempt: i, tries, error: e.message }); } catch {} }
      if (i < tries) await new Promise((r) => setTimeout(r, baseDelayMs * i));
    }
  }
  throw lastErr;
}

// Poll `check()` (truthy = ready) until ready or timeout. Used to wait for Docker
// to come up after install (user may need to finish UAC / a reboot) and for the
// container's :8008 health.
async function waitUntil(check, { totalMs = 600000, everyMs = 4000, onTick = null } = {}) {
  const deadline = Date.now() + totalMs;
  let n = 0;
  while (Date.now() < deadline) {
    if (await check()) return true;
    n++;
    if (onTick) { try { onTick({ waitedMs: Date.now() - (deadline - totalMs), n }); } catch {} }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

// content-length via HEAD (follows redirects). Used to know if a partial/complete
// file is already on disk so we can skip or resume instead of re-downloading.
function headSize(url, hops = 5) {
  return new Promise((resolve) => {
    if (hops <= 0) return resolve(0);
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.request(url, { method: "HEAD", timeout: 15000, headers: { "User-Agent": DL_UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return headSize(res.headers.location, hops - 1).then(resolve);
      }
      resolve(Number(res.headers["content-length"]) || 0);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.end();
  });
}

// HEAD the URL and return a freshness fingerprint (ETag, else Last-Modified).
// Mirrors headSize (follows redirects, node http so it works without curl).
// "" on any failure → callers treat unknown as "can't prove fresh".
function headETag(url, hops = 5) {
  return new Promise((resolve) => {
    if (hops <= 0) return resolve("");
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.request(url, { method: "HEAD", timeout: 15000, headers: { "User-Agent": DL_UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return headETag(res.headers.location, hops - 1).then(resolve);
      }
      resolve(String(res.headers["etag"] || res.headers["last-modified"] || "").trim());
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.end();
  });
}

// Marker recording the OSS fingerprint of the image tarball we last `docker load`ed.
// Lets recreate/bootstrap detect a refreshed OSS image (same `:latest` tag, new
// content) and re-pull — without it, `imagePresent()` stays true forever and the
// machine is pinned to a stale image (bug: "为什么没用最新的docker").
function imageEtagPath() { return path.join(downloadsDir(), "cicy-code-latest.etag"); }
function readLoadedImageEtag() { try { return fs.readFileSync(imageEtagPath(), "utf8").trim(); } catch { return ""; } }
function writeLoadedImageEtag(v) { try { fs.writeFileSync(imageEtagPath(), String(v || "")); } catch {} }
async function remoteImageEtag() { return headETag(R2_TARBALL); }
// Drop the cached tarball so a stale copy on disk can't be reused (downloadImageTarball
// skips a complete file by size, which a same-size new image would wrongly satisfy).
function clearImageTarball() { try { fs.unlinkSync(imageTarballPath()); } catch {} }

// Download `url`→`dest` but: SKIP if the file is already complete, RESUME if it's
// a partial, retry with progress, fall back to `mirror`. This is the core of the
// user's "下载了就不重复下载 / 步骤走过的不要再走".
async function ensureDownloaded(url, dest, mirror, { emit, phase, label, freshOnIncomplete = false } = {}) {
  const expected = (await headSize(url)) || (mirror ? await headSize(mirror) : 0);
  let have = 0; try { have = fs.statSync(dest).size; } catch {}
  // Complete file already on disk → skip (完整的 exe/镜像包就别重下了；用户
  // 自己下到 ~/Downloads 同名文件也走这条直接复用).
  if (expected > 0 && have === expected) {
    emit && emit({ phase, status: "skip", message: `${label}：已下载，跳过`, progress: 100, received: have, total: expected, url, dest });
    return dest;
  }
  // A partial left by a PREVIOUS, interrupted/restarted session can be corrupt;
  // when freshOnIncomplete, delete it and start clean rather than range-resuming
  // onto a possibly-bad file (下载被重启打断的残包要删掉重下). Within THIS
  // session, retries still resume the part we wrote ourselves.
  if (freshOnIncomplete && have > 0 && expected > 0 && have !== expected) {
    try { fs.unlinkSync(dest); } catch {}
    have = 0;
    emit && emit({ phase, status: "running", message: `${label}：删除不完整的旧包，重新下载`, progress: 0 });
  }
  const sources = mirror ? [url, mirror] : [url];
  let lastPct = -1; // throttle: chunks arrive dozens/s — only emit on whole-percent change
  const attempted = withRetry(async (attempt) => {
    const src = sources[Math.min(attempt - 1, sources.length - 1)];
    // 断点续传 : resume the partial via a Range request instead of
    // restarting from 0 — efficient on a flaky network. The post-download size
    // check below + loadImage's load-failure cleanup guard against a bad partial.
    await download(src, dest, {
      resume: true,
      onProgress: ({ received, total }) => {
        const pct = total ? Math.round((received / total) * 100) : 0;
        if (pct === lastPct) return;
        lastPct = pct;
        // `url` = source, `dest` = local target path (UI 显示下载目录; lets the
        // user drop a manual download at the same path and have it reused).
        emit && emit({ phase, status: "running", message: label, progress: pct, received, total, url: src, dest });
      },
    });
    if (expected > 0) {
      const got = fs.statSync(dest).size;
      if (got < expected) throw new Error(`incomplete ${got}/${expected}`);
    }
    return dest;
  }, {
    tries: 6,
    onAttempt: ({ attempt, tries, error }) =>
      emit && emit({ phase, status: "retry", message: `${label}：重试 (${attempt}/${tries})`, error }),
  });
  return attempted.catch((e) => {
    // Offline fallback: the network (and HEAD) may be dead while a complete
    // file from an earlier run sits on disk — use it instead of dying. Only
    // when we CAN'T prove it incomplete (no expected size, or sizes match).
    let have = 0; try { have = fs.statSync(dest).size; } catch {}
    if (have > 0 && (expected === 0 || have === expected)) {
      console.warn(`[docker-sidecar] download failed (${e.message}) — using existing ${dest} (${have}B, unverified)`);
      emit && emit({ phase, status: "skip", message: `${label}：网络不可达，使用本地已有文件`, progress: 100 });
      return dest;
    }
    throw e;
  });
}

// The container's cicy-code mints its own api_token in its volume-persisted
// global.json — the HOST's global.json token is a different credential and
// won't verify. Read the real one out of whatever container publishes :port
// (works for adopted legacy-named containers too).
async function readContainerToken(port = 8008) {
  try {
    const { stdout } = await run(["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"]);
    const name = stdout.trim().split("\n")[0];
    if (!name) return "";
    const r = await run(["exec", name, "cat", "/home/cicy/cicy-ai/global.json"], { timeout: 10000 });
    return (JSON.parse(r.stdout).api_token || "");
  } catch { return ""; }
}

// HTTP /health probe of the container on :port.
function probeHealth(port = 8008, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs }, (res) => {
      res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// The R2 image tarball downloads to ~/Downloads (docker image 下到
// ~/Downloads — visible, like the Docker installer on the Desktop). STABLE name
// (no pid) so a re-run reuses an existing partial/complete file (resume-friendly
// on a flaky network).
// Both the Docker installer AND the image tarball download here (都下到
// ~/Downloads). If the user manually downloads either file to this folder with
// the SAME name, ensureDownloaded sees a complete file and skips the download.
function downloadsDir() {
  const dir = path.join(process.env["USERPROFILE"] || os.homedir(), "Downloads");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function imageTarballPath() {
  return path.join(downloadsDir(), "cicy-code-latest.tar.gz");
}

// Reuse a Docker Desktop installer the user already dropped in ~/Downloads (
// 我已把 exe 放进 Downloads 了) — skip the (slow) download entirely. Accepts the
// canonical "Docker Desktop Installer.exe" plus common variants. Returns the
// path to the largest matching .exe (the real ~600MB installer, not a stub).
function findExistingInstaller() {
  try {
    const dir = downloadsDir();
    const hits = fs.readdirSync(dir)
      .filter((f) => /\.exe$/i.test(f) && /docker/i.test(f) && /(install|desktop)/i.test(f))
      .map((f) => { const p = path.join(dir, f); let size = 0; try { size = fs.statSync(p).size; } catch {} return { p, size }; })
      .filter((x) => x.size > 50 * 1024 * 1024) // a real installer is hundreds of MB, skip stubs
      .sort((a, b) => b.size - a.size);
    return hits.length ? hits[0].p : null;
  } catch { return null; }
}

// Download via the OS `curl` binary. node's http.get stalls at ~150KB/s on this
// R2 endpoint while curl.exe sustains ~1.4MB/s (10×) — so for the big image
// tarball we shell out to curl. `-C -` resumes a partial; progress comes from
// polling the file size against the HEAD content-length.
// --retry-all-errors was added in curl 7.71. Older builds (e.g. Win10's bundled
// curl 7.55.1) reject it with "option ... is unknown" → exit 2, which then
// dropped us to the slow node downloader on EVERY image pull. Probe the version
// once and only pass the flag when supported.
let _curlRetryAllErrors = null;
function curlSupportsRetryAllErrors(bin) {
  if (_curlRetryAllErrors !== null) return _curlRetryAllErrors;
  try {
    const out = execFileSync(bin, ["-V"], { encoding: "utf8", windowsHide: true });
    const m = /libcurl\/(\d+)\.(\d+)/.exec(out);
    const major = m ? Number(m[1]) : 0, minor = m ? Number(m[2]) : 0;
    _curlRetryAllErrors = major > 7 || (major === 7 && minor >= 71);
  } catch { _curlRetryAllErrors = false; }
  return _curlRetryAllErrors;
}

function curlDownload(url, dest, { emit, phase = "image", label = "下载镜像" } = {}) {
  return new Promise(async (resolve, reject) => {
    let total = 0; try { total = await headSize(url); } catch {}
    const bin = process.platform === "win32" ? "curl.exe" : "curl";
    // --retry-connrefused (curl 7.52+) covers a not-yet-ready net. On curl 7.71+
    // also add --retry-all-errors so a transient DNS blip (exit 6, common right
    // after app start) retries on the fast curl path instead of the slow node one.
    const args = ["-sL", "-A", DL_UA, "-C", "-", "--retry", "8", "--retry-delay", "3", "--retry-connrefused"];
    if (curlSupportsRetryAllErrors(bin)) args.push("--retry-all-errors");
    args.push("-o", dest, url);
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); }
    catch (e) { return reject(e); }
    let lastPct = -1;
    const timer = setInterval(() => {
      let have = 0; try { have = fs.statSync(dest).size; } catch {}
      const pct = total ? Math.round((have / total) * 100) : 0;
      if (pct === lastPct) return;
      lastPct = pct;
      emit && emit({ phase, status: "running", message: label, progress: pct, received: have, total, url, dest });
    }, 1000);
    child.on("error", (e) => { clearInterval(timer); reject(e); });
    child.on("close", (code) => {
      clearInterval(timer);
      if (code !== 0) return reject(new Error(`curl exit ${code}`));
      let have = 0; try { have = fs.statSync(dest).size; } catch {}
      if (total && have < total) return reject(new Error(`incomplete ${have}/${total}`));
      emit && emit({ phase, status: "running", message: label, progress: 100, received: have, total, url, dest });
      resolve(dest);
    });
  });
}

// Download the R2 base-env image tarball (no docker needed yet). Split out of
// loadImage so bootstrap can run this IN PARALLEL with the Docker install
// (装 Docker 的同时下载 R2 镜像). Returns the tarball path. Prefers curl
// (much faster here); falls back to the node downloader if curl is unavailable.
async function downloadImageTarball({ emit } = {}) {
  const dest = imageTarballPath();
  // REUSE a complete tarball already on disk (staged into ~/Downloads, or a prior
  // run) BEFORE curlDownload touches it — curlDownload doesn't skip a complete file
  // (and a failed curl truncates it). headSize uses node http so it works even when
  // curl can't resolve the host. Skips the ~500MB re-download per new user.
  try {
    const expected = await headSize(R2_TARBALL);
    const have = fs.statSync(dest).size;
    if (expected > 0 && have === expected) {
      emit && emit({ phase: "image", status: "skip", message: "镜像:已有完整包,跳过下载", progress: 100, received: have, total: expected });
      return dest;
    }
  } catch {}
  try { await curlDownload(R2_TARBALL, dest, { emit, phase: "image", label: "下载镜像" }); }
  catch (e) {
    emit && emit({ phase: "image", status: "running", message: `curl 下载失败(${e.message}),改用内置下载…` });
    await ensureDownloaded(R2_TARBALL, dest, null, { emit, phase: "image", label: "下载镜像" });
  }
  return dest;
}

// `docker load` an already-downloaded tarball + re-tag to IMAGE. Needs the
// daemon up, so this runs AFTER Docker is ready (再导入 docker).
async function loadImageFromTarball(tmp, { emit } = {}) {
  // NO progress:100 here — `docker load` is a separate, no-byte-progress step.
  // Emitting 100% made the bar look "done" while the (slow) load was still
  // running, so the user saw 100% but it wasn't finished (bug). The drawer
  // shows this as the active "导入镜像" step with a spinner instead.
  emit && emit({ phase: "image", status: "loading", message: "正在导入镜像到 Docker（较大，约 1-3 分钟，请稍候）…" });
  console.log(`[docker-sidecar] docker load…`);
  let stdout;
  try {
    ({ stdout } = await run(["load", "-i", tmp], { timeout: 300000 }));
  } catch (e) {
    // A resumed download can leave a byte-correct-size but corrupt tarball that
    // `docker load` rejects. Delete it so the next attempt re-downloads fresh
    // (断点续传 normally, fresh only when proven bad).
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  // The tarball's embedded tag may be a pinned version (e.g. :2.1.6) while we
  // run IMAGE (:latest). Re-tag whatever was loaded so imagePresent()/start()
  // match — otherwise every start() re-downloads the tarball forever.
  const m = String(stdout).match(/Loaded image:\s*(\S+)/i);
  if (m && m[1] !== IMAGE) {
    try { await run(["tag", m[1], IMAGE]); console.log(`[docker-sidecar] tagged ${m[1]} -> ${IMAGE}`); }
    catch (e) { console.warn(`[docker-sidecar] re-tag failed: ${e.message}`); }
  }
  // Keep the tarball in ~/Downloads (下到 Downloads) — it's a visible,
  // resume-friendly cache; imagePresent() gates re-entry so we don't re-load it.
}

// Download-then-import in one shot (sequential). Used when Docker is already up.
async function loadImage({ emit } = {}) {
  const tmp = await downloadImageTarball({ emit });
  await loadImageFromTarball(tmp, { emit });
}

// `docker restart` / graceful `docker stop` for a given container — the Docker-版
// card's ⋯ menu (重启 / 停止), mirroring the 8008 local card's lifecycle menu.
async function restart({ container = CONTAINER } = {}) {
  await run(["restart", container], { timeout: 60000 });
}
async function stopContainer({ container = CONTAINER } = {}) {
  try { await run(["stop", container], { timeout: 30000 }); } catch {}
}

async function checkStatus() {
  const installed = await dockerOk();
  return { installed, imagePresent: installed ? await imagePresent() : false };
}

// Resolve the user's Desktop folder (docker-desktop.exe 下到 Desktop).
// %USERPROFILE%\Desktop is the canonical location; OneDrive redirection is rare
// on the target machines and the file is only a transient installer anyway.
function desktopDir() {
  return path.join(process.env["USERPROFILE"] || os.homedir(), "Desktop");
}

// Start the container. Returns a sidecar child token { docker:true, container,
// id } or null when Docker isn't ready (homepage guides the user to install
// Docker Desktop). `container`/`volume` are parameterized so a SECOND instance
// (the Docker-版 cicy-code on :8008) can run alongside the native local one
// without a name/volume collision.
async function start({ port = 8008, container = CONTAINER, volume = VOLUME, mountTarget = "/home/cicy/cicy-ai", env = {} } = {}) {
  // Something already serves a healthy cicy-code on :port (a legacy-named
  // container auto-revived by `--restart unless-stopped`, a manual run…).
  // Adopt it — `docker run` would just lose the port-bind fight.
  if (await probeHealth(port)) {
    console.log(`[docker-sidecar] :${port} already healthy — adopting existing instance`);
    return { docker: true, container, adopted: true };
  }
  if (!(await dockerOk())) {
    console.warn("[docker-sidecar] Docker not available — homepage will guide install");
    return null;
  }
  if (!(await imagePresent())) {
    try { await loadImage(); }
    catch (e) { console.warn(`[docker-sidecar] image load failed: ${e.message}`); return null; }
  }
  // Replace any stale container of the same name.
  try { await run(["rm", "-f", container]); } catch {}

  // mountTarget defaults to /home/cicy/cicy-ai (legacy local-team layout); the
  // Docker-版 instance passes /home/cicy to persist the WHOLE cicy home (
  // "把整个 docker 挂出来" — everything mutable lives under /home/cicy: global.json,
  // db, agents, files, the npm-installed cicy-code itself).
  const args = [
    "run", "-d", "--name", container, "--restart", "unless-stopped",
    "-p", `${port}:8008`,
    "-v", `${volume}:${mountTarget}`,
  ];
  for (const k of PASS_ENV) {
    if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  }
  // Caller-supplied env (e.g. the LLM gateway endpoint + key for the Docker-版
  // instance, which bills through the 8008 local team's token).
  for (const [k, v] of Object.entries(env || {})) {
    if (v != null && v !== "") args.push("-e", `${k}=${v}`);
  }
  args.push(IMAGE);

  const { stdout } = await run(args, { timeout: 60000 });
  const id = stdout.trim().slice(0, 12);
  console.log(`[docker-sidecar] started container ${container} (${id}) on :${port}`);
  return { docker: true, container, id };
}

async function stop({ container = CONTAINER } = {}) {
  try { await run(["rm", "-f", container]); } catch {}
}

// Download + run the Docker Desktop installer (Windows). The installer needs
// admin → Windows shows a UAC prompt the user accepts; first run may want a
// reboot. We download (skip/resume aware) then launch silent and return.
// `dest` defaults to tmp (the legacy local-team path); the Docker-版 card passes
// the Desktop folder so the user can see/keep the installer.
async function installDocker({ emit, dest } = {}) {
  const e = emit || (() => {});
  const target = dest || path.join(os.tmpdir(), "DockerDesktopInstaller.exe");
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
  e({ phase: "install-docker", status: "running", message: "下载 Docker Desktop 安装包…", progress: 0 });
  await ensureDownloaded(DOCKER_DESKTOP_URL, target, DOCKER_DESKTOP_MIRROR, {
    emit, phase: "install-docker", label: "下载 Docker Desktop",
  });
  e({ phase: "install-docker", status: "running", message: "安装 Docker Desktop（请在弹出的管理员授权框点「是」，装完可能需重启）…" });
  await launchElevated(target, ["install", "--quiet", "--accept-license"], { emit: e });
}

// Run an admin-manifest exe (the Docker Desktop installer) ELEVATED + in the
// user's INTERACTIVE session so its GUI is visible. A plain spawn fails (740,
// no UAC). The reliable method on these machines (verified) is a one-shot
// scheduled task with /rl HIGHEST /it: it runs with the built-in Administrator's
// elevated token (no UAC prompt) in the logged-on session, and — unlike
// cscript/VBS ShellExecute "runas" — isn't blocked by 360. cscript is kept only
// as a last-ditch fallback.
function elevateViaTask(exe, args) {
  return new Promise((resolve) => {
    try {
      const user = process.env["USERNAME"] || "Administrator";
      const stamp = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
      const tn = `cicy-elevate-${stamp}`;
      // A wrapper .cmd in a no-space temp path avoids schtasks /tr quoting hell;
      // the .cmd itself quotes the (space-containing) exe path.
      const cmdPath = path.join(os.tmpdir(), `${tn}.cmd`);
      const line = `"${exe}"` + (args.length ? " " + args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") : "");
      fs.writeFileSync(cmdPath, `@echo off\r\n${line}\r\n`, "utf8");
      const sch = (a, cb) => execFile("schtasks", a, { windowsHide: true }, cb);
      sch(["/create", "/tn", tn, "/tr", cmdPath, "/sc", "ONCE", "/st", "00:00", "/rl", "HIGHEST", "/ru", user, "/it", "/f"], (err) => {
        if (err) return resolve(false);
        sch(["/run", "/tn", tn], (rerr) => {
          // clean the task + wrapper after a delay (installer keeps running).
          setTimeout(() => { sch(["/delete", "/tn", tn, "/f"], () => {}); try { fs.unlinkSync(cmdPath); } catch {} }, 30000);
          resolve(!rerr);
        });
      });
    } catch { resolve(false); }
  });
}

function launchElevated(exe, args, { emit } = {}) {
  return new Promise(async (resolve) => {
    // 1) Preferred: scheduled task /rl HIGHEST (elevated, interactive, 360-safe).
    if (await elevateViaTask(exe, args)) return resolve(true);
    // 2) Fallback: cscript/VBS ShellExecute "runas" (shows a UAC prompt).
    try {
      const vbs = path.join(os.tmpdir(), "cicy-docker-elevate.vbs");
      const argStr = args.join(" ").replace(/"/g, '""');
      const exeEsc = String(exe).replace(/"/g, '""');
      fs.writeFileSync(vbs, `Set s = CreateObject("Shell.Application")\r\ns.ShellExecute "${exeEsc}", "${argStr}", "", "runas", 0\r\n`, "utf8");
      const child = spawn("cscript", ["//nologo", vbs], { windowsHide: true, detached: true, stdio: "ignore" });
      let done = false; const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
      child.on("error", () => {
        try {
          emit && emit({ phase: "install-docker", status: "running", message: "提权方式受限，尝试直接启动安装包…" });
          const c2 = spawn(exe, args, { windowsHide: false, detached: true, stdio: "ignore" });
          c2.on("error", () => fin(false)); c2.on("spawn", () => fin(true)); c2.on("exit", () => fin(true));
        } catch { fin(false); }
      });
      child.on("exit", () => fin(true));
    } catch { resolve(false); }
  });
}

// Absolute path of wsl.exe. The desktop can be launched (login item / task) with a
// PATH that lacks System32, and then every bare "wsl" spawn fails with ENOENT
// ("spawn wsl ENOENT" seen in the field). Prefer the inbox binary, then the
// Store version, then fall back to the bare name.
function wslExe() {
  if (process.platform !== "win32") return "wsl";
  const sysroot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const cands = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "WSL", "wsl.exe"), // 新版 WSL(MSI),优先
    path.join(sysroot, "System32", "wsl.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "wsl.exe"),
  ];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return "wsl";
}

// Docker Desktop on Windows needs a WSL2 (or Hyper-V) backend — without it the
// engine never starts and `docker version` can't reach the daemon, so the card
// hangs on "正在启动 Docker Desktop". Detect a missing WSL. `wsl` prints UTF-16
// and a fresh Windows without the feature says "未安装 / not installed / can be
// installed by running wsl.exe --install".
async function wslMissing() {
  if (process.platform !== "win32") return false;
  // ASYNC execFile, NOT execFileSync: this runs on the homepage's status poll,
  // and a cold post-reboot WSL can take many seconds to answer `wsl --status`.
  // A sync call there blocked the whole Electron main process → the window went
  // "未响应". Capture stdout+stderr even on a non-zero exit (a fresh Windows
  // without WSL prints the "not installed / --install" hint and exits non-zero).
  // TRI-STATE: true = WSL missing, false = WSL present, null = couldn't tell
  // (wsl didn't answer / timed out). null lets status() report `unknown` instead
  // of falsely concluding "not installed" when WSL is merely stuck.
  return await new Promise((resolve) => {
    execFile(wslExe(), ["--status"], { timeout: 25000, windowsHide: true, encoding: "utf16le" }, (err, stdout, stderr) => {
      const s = String((stdout || "") + (stderr || "") + (err && err.message ? err.message : ""));
      // wsl.exe 不存在(ENOENT):功能刚启用但还没重启 Windows 时就是这样 —— 按「缺失」处理,
      // 让 ensureWsl 走 needsReboot,而不是当成已就绪去 --import 然后 spawn ENOENT。
      if (err && (err.code === "ENOENT" || /ENOENT/.test(err.message || ""))) return resolve(true);
      // 用法帮助有两种来源:(a) 功能刚启用还没重启的存根 wsl.exe —— 任何子命令都只打印帮助;
      // (b) 老版 Win10(19042 等)的内置 wsl.exe 根本不认识 `--status`,也打印帮助,但 WSL 本身
      // 完全可用。只看帮助文本区分不了 → 再用 `wsl -l -v` 功能探测:能列出/说"没有发行版"就是可用。
      if (/未安装|not installed|--install|\[Argument\]|\[参数\]/i.test(s)) {
        return wslFunctional().then((ok) => resolve(!ok));
      }
      if (err && (err.killed || err.signal || err.code === "ETIMEDOUT")) return resolve(null); // timed out → unknown
      resolve(false); // wsl present (errored for another reason → assume OK)
    });
  });
}

// True iff a Windows optional feature is enabled. Primary source: WMI
// Win32_OptionalFeature (InstallState 1=Enabled, 2=Disabled) — readable WITHOUT
// elevation, unlike `dism /get-featureinfo`, which prints nothing at medium
// integrity (the desktop normally runs unelevated even for admin accounts) and
// was being misread as "disabled". dism stays as the fallback when WMI is unavailable.
function featureEnabled(feature) {
  return new Promise((resolve) => {
    const ps = `(Get-CimInstance Win32_OptionalFeature -Filter "Name='${feature}'").InstallState`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 30000, windowsHide: true }, (err, out) => {
      const v = String(out || "").trim();
      if (!err && /^[0-9]+$/.test(v)) return resolve(v === "1");
      execFile("dism", ["/english", "/online", "/get-featureinfo", `/featurename:${feature}`],
        { timeout: 30000, windowsHide: true },
        (_e, out2) => resolve(/State\s*:\s*Enabled/i.test(String(out2 || ""))));
    });
  });
}

// 新版 WSL(微软独立发布的 MSI,Store 版同源):不走旧的 LxssManager、内核内置、`--status` 等命令
// 齐全、localhost 转发稳定。老 Win10 自带的旧版 WSL 反复死锁/半死/缺内核,全部由它一次解决。
// MSI 由发布工作流从 GitHub 镜像到 OSS(国内可下)。
const WSL_MODERN_MSI_URL = process.env.CICY_WSL_MSI_URL || (require("./mirrors").R2_RELEASES_BASE + "/wsl/wsl.x64.msi");
function modernWslInstalled() {
  if (process.platform !== "win32") return true;
  try { return fs.existsSync(path.join(process.env.ProgramFiles || "C:\\Program Files", "WSL", "wsl.exe")); } catch { return false; }
}
// 这台机器的旧版 WSL 出过死锁/被自动重启过(db/wsl-reboots.json 有计数)→ 下次提权时顺手换新版。
function legacyWslTroubleSeen() {
  try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), "cicy-ai", "db", "wsl-reboots.json"), "utf8")); return (Number(j.count) || 0) > 0; } catch { return false; }
}
const WSL_KERNEL_MSI_URL = process.env.CICY_WSL_KERNEL_URL || "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi";
// 裸内核文件(由发布工作流从 MSI 解出后放到 OSS):精简版 Windows 没有 msiexec 时直接放到位。
const WSL_KERNEL_RAW_URL = process.env.CICY_WSL_KERNEL_RAW_URL || (require("./mirrors").R2_RELEASES_BASE + "/wsl-kernel/kernel");
// WSL2 kernel present? The inbox (feature-based) WSL keeps it at System32\lxss\tools\kernel;
// the Store WSL bundles its own, in which case the file is absent but `wsl --status`
// reports a kernel version — callers treat "functional + version" as present too.
function wslKernelPresent() {
  if (process.platform !== "win32") return true;
  const sysroot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  try { if (fs.existsSync(path.join(sysroot, "System32", "lxss", "tools", "kernel"))) return true; } catch {}
  try { if (fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "wsl.exe")) && fs.existsSync(path.join(process.env.ProgramFiles || "C:\\Program Files", "WSL", "wsl.exe"))) return true; } catch {}
  return false;
}

// Functional WSL probe that needs no elevation: `wsl -l -v` on a machine with
// the features enabled (and rebooted) either lists distros or says "no installed
// distributions"; with the features off it prints the "--install" help text.
function wslFunctional() {
  if (process.platform !== "win32") return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile(wslExe(), ["-l", "-v"], { timeout: 25000, windowsHide: true, encoding: "utf16le" }, (err, stdout, stderr) => {
      const s = String((stdout || "") + (stderr || "")).replace(/\u0000/g, "");
      if (/NAME\s+STATE|没有已安装的分发版|no installed distributions|aka\.ms\/wslstore|名称\s+状态/i.test(s)) return resolve(true);
      resolve(false);
    });
  });
}

// Enable ONE Windows optional feature, elevated, and WAIT until it actually
// reports Enabled. The old `wsl --install` was fire-and-forget — it could
// silently no-op, leaving the card stuck on "reboot required" forever. Here we
// drive DISM and verify, streaming every step to the install drawer.
async function dismEnableFeature(feature, label, { emit } = {}) {
  if (await featureEnabled(feature)) {
    emit && emit({ phase: "install-docker", status: "running", message: `${label}：已启用，跳过` });
    return true;
  }
  emit && emit({ phase: "install-docker", status: "running", message: `${label}：正在启用（约 1–2 分钟，请稍候）…` });
  await launchElevated("dism", ["/online", "/enable-feature", `/featurename:${feature}`, "/all", "/norestart"], { emit }).catch(() => {});
  // launchElevated fires the elevated task and returns immediately; poll the
  // real feature state (DISM exits 3010 = success + reboot-required).
  const ok = await waitUntil(() => featureEnabled(feature), { totalMs: 240000, everyMs: 5000 });
  emit && emit({ phase: "install-docker", status: ok ? "running" : "error", message: ok ? `${label}：已启用 ✓` : `${label}：未能确认启用（点「重试」）` });
  return ok;
}

// ONE elevated PowerShell run (= one UAC) that does everything WSL2 needs on this
// machine: enable both features, and when Windows' component store refuses
// (0x8007371b ERROR_SXS_TRANSACTION_CLOSURE_INCOMPLETE etc.) run
// DISM /RestoreHealth + sfc and retry; install the WSL2 kernel MSI if a copy is
// already downloaded. Progress is read back from a result file; feature state is
// verified via WMI (no elevation needed). Previously this was 2–3 separate
// elevations (dism ×2 + msiexec) → 2–3 UAC prompts, and any unattended one failed.
function elevatedWslSetup({ emit, need = {} } = {}) {
  return new Promise(async (resolve) => {
    const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "cicy-desktop");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const ps1 = path.join(dir, "wsl-setup.ps1");
    const resultFile = path.join(dir, "wsl-setup.result.txt");
    try { fs.unlinkSync(resultFile); } catch {}
    const msi = path.join(os.homedir(), "Downloads", "wsl_update_x64.msi");
    const script = [
      '$ErrorActionPreference = "Continue"',
      `$R = "${resultFile.replace(/"/g, '""')}"`,
      'function Say($m) { Add-Content -Path $R -Value ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $m) }',
      'function St($n) { try { (Get-CimInstance Win32_OptionalFeature -Filter ("Name=\'" + $n + "\'")).InstallState } catch { 0 } }',
      '$S32 = Join-Path $env:SystemRoot "System32"; $DISM = Join-Path $S32 "dism.exe"; $SFC = Join-Path $S32 "sfc.exe"; $MSIEXEC = Join-Path $S32 "msiexec.exe"',
      'function En($n) { & $DISM /online /enable-feature /featurename:$n /all /norestart | Out-Null; $c = $LASTEXITCODE; Say ("enable " + $n + " exit=" + $c); return $c }',
      'Say "start admin=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(\'Administrators\'))"',
      '$feats = @("Microsoft-Windows-Subsystem-Linux","VirtualMachinePlatform")',
      '$bad = @(); foreach ($f in $feats) { if ((St $f) -ne 1) { $c = En $f; if ($c -ne 0 -and $c -ne 3010) { $bad += $f } } }',
      `$REPAIRED = "${path.join(dir, "wsl-repair-attempted.txt").replace(/"/g, '""')}"`,
      'if ($bad.Count -gt 0 -and (Test-Path $REPAIRED)) { Say "repair already attempted before and the feature still cannot be enabled — skipping the 30-min repair; this Windows image is missing the feature payload (reinstall/repair Windows needed)" }',
      'if ($bad.Count -gt 0 -and -not (Test-Path $REPAIRED)) {',
      '  Set-Content -Path $REPAIRED -Value (Get-Date -Format s)',
      '  Say "repair: DISM /RestoreHealth (component store refused: $($bad -join \',\')) — this can take 10-30 min"',
      '  & $DISM /online /cleanup-image /restorehealth /norestart | Out-Null; Say ("restorehealth exit=" + $LASTEXITCODE)',
      '  & $SFC /scannow | Out-Null; Say ("sfc exit=" + $LASTEXITCODE)',
      '  foreach ($f in $bad) { $c = En $f }',
      '}',
      `$MODERN = Join-Path $env:ProgramFiles "WSL\\wsl.exe"`,
      `if (-not (Test-Path $MODERN) -and (Test-Path $MSIEXEC)) {`,
      `  $wm = Join-Path $env:USERPROFILE "Downloads\\wsl.x64.msi"`,
      `  Say "installing modern WSL (replaces the legacy inbox WSL: no LxssManager deadlocks, kernel built in) — download ~250MB"`,
      `  try { if (-not (Test-Path $wm) -or (Get-Item $wm).Length -lt 100000000) { Invoke-WebRequest -UseBasicParsing -Uri "${WSL_MODERN_MSI_URL}" -OutFile $wm }; $p = Start-Process $MSIEXEC -ArgumentList "/i","\`"$wm\`"","/qn","/norestart" -Wait -PassThru; Say ("modern wsl msi exit=" + $p.ExitCode) } catch { Say ("modern wsl install failed: " + $_.Exception.Message) }`,
      `}`,
      `$KDIR = Join-Path $S32 "lxss\\tools"; $KFILE = Join-Path $KDIR "kernel"`,
      `if (-not (Test-Path $KFILE)) {`,
      `  if ((Test-Path $MSIEXEC) -and (Test-Path "${msi.replace(/"/g, '""')}")) { $p = Start-Process $MSIEXEC -ArgumentList "/i","\`"${msi.replace(/"/g, '""')}\`"","/qn","/norestart" -Wait -PassThru; Say ("kernel msi exit=" + $p.ExitCode) }`,
      `  if (-not (Test-Path $KFILE)) {`,
      `    Say "msiexec missing or failed — downloading the raw WSL2 kernel file"`,
      `    New-Item -ItemType Directory -Force $KDIR | Out-Null`,
      `    try { Invoke-WebRequest -UseBasicParsing -Uri "${WSL_KERNEL_RAW_URL}" -OutFile $KFILE; Say ("kernel file " + (Get-Item $KFILE).Length + " bytes") } catch { Say ("kernel download failed: " + $_.Exception.Message) }`,
      `  }`,
      `}`,
      'Say ("final subsystem=" + (St "Microsoft-Windows-Subsystem-Linux") + " vmPlatform=" + (St "VirtualMachinePlatform"))',
      'Say "DONE"',
    ].join("\r\n");
    try { fs.writeFileSync(ps1, "\uFEFF" + script, "utf8"); } catch (e) { return resolve({ subsystem: false, vmPlatform: false, detail: `写提权脚本失败: ${e.message}` }); }
    const launched = await launchElevated("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1], { emit });
    if (!launched) return resolve({ subsystem: false, vmPlatform: false, detail: "无法发起提权（UAC 被拒绝或不可用）" });
    // Follow the result file (progress lines) until DONE; repair paths can take 30 min.
    let seen = 0, detail = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 40 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 4000));
      let lines = [];
      try { lines = fs.readFileSync(resultFile, "utf8").split(/\r?\n/).filter(Boolean); } catch {}
      for (const l of lines.slice(seen)) {
        emit && emit({ phase: "install-docker", status: "running", message: `提权脚本：${l.replace(/^\[[^\]]*\] /, "")}` });
        if (/exit=(?!0\b|3010\b)\d+|repair already attempted/.test(l)) detail = l;
      }
      seen = lines.length;
      if (lines.some((l) => /DONE/.test(l))) break;
      if (Date.now() - t0 > 90 * 1000 && lines.length === 0) { detail = "提权后 90 秒内没有任何进展（UAC 可能没有被点击「是」）"; break; }
    }
    const subsystem = await featureEnabled("Microsoft-Windows-Subsystem-Linux");
    const vmPlatform = await featureEnabled("VirtualMachinePlatform");
    resolve({ subsystem, vmPlatform, detail });
  });
}

// Ensure the WSL2 backend exists; install it (elevated) if missing. Returns
// { ok } when already present, { needsReboot } after the two required Windows
// features are verified-enabled (a Windows reboot is then needed before Docker
// can use WSL2), or { failed } if a feature couldn't be enabled.
// CPU virtualization state (Windows). WSL2 cannot start when the firmware has
// VT-x/AMD-V disabled — and nothing in software can flip that. Detect it up
// front so the failure is EXPLAINED (log + card) instead of a mute install loop.
// hypervisorPresent=true means a hypervisor already runs (Hyper-V/WSL2 active)
// → virtualization is necessarily on, regardless of what the CPU field says.
async function virtualizationStatus() {
  if (process.platform !== "win32") return { known: false };
  return new Promise((resolve) => {
    const ps = "$cs=Get-CimInstance Win32_ComputerSystem; $cpu=Get-CimInstance Win32_Processor | Select-Object -First 1; Write-Output (\"\" + $cs.HypervisorPresent + \"|\" + $cpu.VirtualizationFirmwareEnabled + \"|\" + $cpu.VMMonitorModeExtensions + \"|\" + $cpu.Name)";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      const line = String(stdout || "").trim().split(/\r?\n/).pop() || "";
      const [hv, fw, vmm, ...rest] = line.split("|");
      if (err || !line || line.split("|").length < 3) return resolve({ known: false, raw: line, error: err && err.message });
      const b = (v) => /^true$/i.test(String(v).trim());
      const hypervisorPresent = b(hv), firmwareEnabled = b(fw), cpuSupports = b(vmm);
      resolve({ known: true, hypervisorPresent, firmwareEnabled, cpuSupports, cpu: rest.join("|").trim(), ok: hypervisorPresent || firmwareEnabled });
    });
  });
}

// 桌面端能不能创建子进程。安全软件(360/火绒/Defender ASR)拦截 CiCy Desktop.exe 的
// 子进程创建时,每个 execFile/spawn 都报 EPERM:featureEnabled 恒为 false、dism 提权
// 起不来,ensure-wsl 白等 8 分钟后报 wsl_enable_failed,守护循环又立刻重来 —— 用户只看
// 到「安装失败」。这里 1 秒探明,直接给出原因。
function spawnProbe() {
  if (process.platform !== "win32") return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    execFile(process.env.ComSpec || "cmd.exe", ["/d", "/c", "echo ok"], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (!err && /ok/.test(String(stdout || ""))) return resolve({ ok: true });
      resolve({ ok: false, code: (err && err.code) || "unknown", error: err && err.message });
    });
  });
}

async function ensureWsl({ emit } = {}) {
  const sp = await spawnProbe();
  if (!sp.ok) {
    const why = `CiCy Desktop 无法创建子进程（spawn ${sp.code}）——通常是安全软件（360/火绒/Defender）拦截了 CiCy Desktop.exe 启动 cmd/powershell/dism。请把 CiCy Desktop 加入信任并以管理员身份重新打开后点「重试」。`;
    log.error(`[bootstrap] ✗ ensure-wsl reason=spawn_blocked code=${sp.code} err=${sp.error || ""}`);
    emit && emit({ phase: "done", status: "error", message: why });
    return { ok: false, needsReboot: false, failed: true, reason: "spawn_blocked", message: why };
  }
  const virt = await virtualizationStatus();
  if (virt.known && !virt.ok) {
    const why = virt.cpuSupports
      ? `CPU 虚拟化未在 BIOS/固件中开启（Virtualization Enabled In Firmware: No，CPU: ${virt.cpu || "?"}）。请重启进 BIOS 打开 Intel VT-x / AMD SVM 后再点「重试」。`
      : `此 CPU 不支持硬件虚拟化（VM Monitor Mode Extensions: No，CPU: ${virt.cpu || "?"}），无法运行 WSL2 / Docker。`;
    log.error(`[bootstrap] ✗ ensure-wsl reason=virtualization_disabled hypervisorPresent=${virt.hypervisorPresent} firmwareEnabled=${virt.firmwareEnabled} cpuSupports=${virt.cpuSupports} cpu=${virt.cpu}`);
    emit && emit({ phase: "done", status: "error", message: why });
    return { ok: false, needsReboot: false, failed: true, reason: "virtualization_disabled", message: why };
  }
  const executableMissing = await wslMissing();
  const subsystemEnabled = await featureEnabled("Microsoft-Windows-Subsystem-Linux");
  const vmPlatformEnabled = await featureEnabled("VirtualMachinePlatform");
  const state = classifyWslPrerequisites({ executableMissing, subsystemEnabled, vmPlatformEnabled });
  if (state.ready) {
    // 功能都已启用、wsl.exe 也在,但 WSL 本身还不能用(`wsl -l -v` 只打印帮助)= 启用后还没
    // 重启。别去 --import(必失败),直接进自动重启流程。
    if (!(await wslFunctional())) {
      if (!modernWslInstalled() && legacyWslTroubleSeen()) {
        // 旧版 WSL 已经死锁/重启过 → 别再等它,换新版 WSL(一次 UAC),装完重启。
        emit && emit({ phase: "install-docker", status: "running", message: "旧版 WSL 反复无响应,改为安装微软新版 WSL（会弹一次 UAC，请点「是」，下载约 250MB）…" });
        await elevatedWslSetup({ emit, need: {} });
      }
      log.warn("[bootstrap] ensure-wsl: features enabled but WSL not functional yet (pending reboot)");
      emit && emit({ phase: "install-docker", status: "running", message: "WSL 功能已启用但尚未生效,需要重启 Windows…" });
      return { ok: false, needsReboot: true };
    }
    if (!modernWslInstalled() && legacyWslTroubleSeen()) {
      emit && emit({ phase: "install-docker", status: "running", message: "这台机器的旧版 WSL 出过死锁,升级为微软新版 WSL（会弹一次 UAC，下载约 250MB）…" });
      await elevatedWslSetup({ emit, need: {} });
      if (modernWslInstalled()) { emit && emit({ phase: "install-docker", status: "running", message: "新版 WSL 已安装,需要重启 Windows 生效…" }); return { ok: false, needsReboot: true }; }
    }
    // WSL2 内核(lxss\tools\kernel)缺失时 --import 也必失败。先把 MSI 下到 Downloads,再用
    // 同一个提权脚本装(功能已启用的话脚本只做装内核这一件事)。
    if (!wslKernelPresent()) {
      const msi = path.join(os.homedir(), "Downloads", "wsl_update_x64.msi");
      try { await ensureDownloaded(WSL_KERNEL_MSI_URL, msi, null, { emit, phase: "install-docker", label: "下载 WSL2 内核" }); }
      catch (e) { log.warn(`[bootstrap] kernel msi download failed: ${e.message}`); }
      emit && emit({ phase: "install-docker", status: "running", message: "WSL2 内核未安装,开始安装（会弹一次 UAC，请点「是」）…" });
      const r = await elevatedWslSetup({ emit, need: {} });
      if (!wslKernelPresent()) {
        const message = `WSL2 内核未能安装${r.detail ? `（${r.detail}）` : "（UAC 未确认或 MSI 安装失败）"}——会自动重试。`;
        log.error(`[bootstrap] ✗ ensure-wsl reason=wsl_kernel_missing ${r.detail || ""}`);
        emit && emit({ phase: "done", status: "error", message });
        return { ok: false, needsReboot: false, failed: true, reason: "wsl_kernel_missing", message };
      }
    }
    return { ok: true };
  }

  emit && emit({ phase: "install-docker", status: "running", message: "Docker 需要 WSL2 后端，开始启用所需的 Windows 功能（会弹一次 UAC，请点「是」）…" });
  const r = await elevatedWslSetup({ emit, need: { subsystem: !subsystemEnabled, vmPlatform: !vmPlatformEnabled } });
  const a = r.subsystem, b = r.vmPlatform;
  if (!a || !b) {
    const storeBroken = /exit=(14107|3017)|repair already attempted/.test(r.detail || "");
    const message = storeBroken
      ? `Windows 系统组件缺失或损坏，无法启用「虚拟机平台」（DISM 修复后仍失败，错误 14107）。这台 Windows 需要用安装镜像修复（DISM /Source）或重装系统后才能使用 WSL2/Docker。`
      : `WSL 功能未能全部启用（Linux 子系统=${a ? "已启用" : "失败"}，虚拟机平台=${b ? "已启用" : "失败"}${r.detail ? `；${r.detail}` : "；通常是 UAC 被取消或当前账号无管理员权限"}）——会自动重试；也可以点「重试」。`;
    log.error(`[bootstrap] ✗ ensure-wsl reason=wsl_enable_failed subsystem=${a} vmPlatform=${b}`);
    emit && emit({ phase: "done", status: "error", message });
    return { ok: false, needsReboot: false, failed: true, reason: storeBroken ? "windows_component_store_broken" : "wsl_enable_failed", message };
  }
  // Best-effort: also pull the WSL2 kernel/plumbing when the executable itself
  // is missing. Feature-only repairs must stop here and wait for reboot.
  if (state.installWsl) {
    await launchElevated(wslExe(), ["--install", "--no-distribution"], { emit }).catch(() => {});
  }
  emit && emit({ phase: "install-docker", status: "running", message: "WSL2 功能已启用 ✓，请【重启 Windows】；重启后回来点「重试」继续。" });
  return { ok: false, needsReboot: true };
}

// One-shot, idempotent, resumable bootstrap of the whole local-team stack on
// Windows: install Docker (if missing) → load the base image (if missing) →
// start the container → wait for :8008. Every step CHECKS first and SKIPS if
// already done, emits coarse phase events + byte progress, and the downloads
// resume. Safe to call again after a failure — it picks up where it left off.
async function bootstrap({ onProgress, port = 8008, container = CONTAINER, volume = VOLUME, mountTarget, env, installDest } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };

  // Decide up-front whether the base image needs fetching, so we can download
  // the R2 tarball IN PARALLEL with the Docker Desktop install below.
  const needImage = !(await imagePresent());
  let imgDl = null; // Promise<tarballPath|null> when downloading in parallel

  // 1) Docker running? If not, hand off to Docker's OWN installer / app — it
  // installs the WSL2 backend and handles the reboot far better than we can
  // (下载完直接弹官方安装程序，让用户自己装，别搞那么复杂). We don't silent-
  // install / auto-WSL / poll for 15 min; we open it, tell the user, and stop.
  // They click 重试 once Docker's whale icon is green.
  if (await dockerOk()) {
    emit({ phase: "install-docker", status: "skip", message: "Docker 已安装，跳过" });
  } else if (!dockerDesktopExe()) {
    // Not installed → use the installer the user already put in ~/Downloads if
    // present (我已把 exe 放进 Downloads 了), else download it; then OPEN it.
    let dest = findExistingInstaller();
    if (dest) {
      emit({ phase: "install-docker", status: "skip", message: `使用 ~/Downloads 里已有的安装包：${path.basename(dest)}`, progress: 100, dest });
    } else {
      dest = installDest || path.join(downloadsDir(), "Docker Desktop Installer.exe");
      emit({ phase: "install-docker", status: "running", message: "下载 Docker Desktop 安装包…", progress: 0 });
      try {
        await ensureDownloaded(DOCKER_DESKTOP_URL, dest, DOCKER_DESKTOP_MIRROR, { emit, phase: "install-docker", label: "下载 Docker Desktop" });
      } catch (e) {
        emit({ phase: "done", status: "error", message: `安装包下载失败：${e.message}（点重试续传）` });
        return { ok: false, reason: "installer_download_failed" };
      }
    }
    emit({ phase: "install-docker", status: "running", message: "打开 Docker Desktop 安装程序，请按提示完成安装…" });
    await launchElevated(dest, [], { emit }); // GUI installer (UAC); user drives it
    emit({ phase: "done", status: "installer", message: "已打开 Docker 安装程序——请完成安装（它会装 WSL2、可能需要重启），装好后回来点「重试」。" });
    return { ok: false, reason: "installer_launched" };
  } else {
    // Installed but the engine is down → just open Docker Desktop; it self-heals
    // (prompts to enable WSL2 / restart if needed). Give it a short window to
    // come up in case it only needed a kick; otherwise hand back to the user.
    emit({ phase: "install-docker", status: "running", message: "启动 Docker Desktop…" });
    startDockerDesktop();
    const up = await waitUntil(dockerOk, { totalMs: 90000, everyMs: 5000 });
    if (!up) {
      emit({ phase: "done", status: "installer", message: "已打开 Docker Desktop——请按它的提示完成设置（首次可能要装 WSL2 / 重启），等鲸鱼图标变绿后点「重试」。" });
      return { ok: false, reason: "installer_launched" };
    }
    emit({ phase: "install-docker", status: "done", message: "Docker 就绪" });
  }

  // 2) Base image — import it (docker load). If pre-downloaded in parallel, just
  // load; otherwise (re)download now. Downloads resume/skip + delete bad partials.
  if (!needImage) {
    emit({ phase: "image", status: "skip", message: "镜像已就绪，跳过" });
  } else {
    try {
      let tmp = imgDl ? await imgDl : null;
      if (!tmp) tmp = await downloadImageTarball({ emit }); // not pre-dl'd / parallel dl failed → fetch now
      await loadImageFromTarball(tmp, { emit });
      emit({ phase: "image", status: "done", message: "镜像就绪" });
    } catch (e) {
      emit({ phase: "image", status: "error", message: `镜像加载失败：${e.message}（点重试,下载会续传）` });
      return { ok: false, reason: "image_load_failed" };
    }
  }

  // 3) Container — skip when :port is already healthy (idempotent re-entry);
  // start() additionally adopts an existing instance instead of port-fighting.
  if (await probeHealth(port)) {
    emit({ phase: "container", status: "skip", message: "本地服务已在运行，跳过" });
  } else {
    emit({ phase: "container", status: "running", message: "启动 cicy-code 容器…" });
    let child = null;
    try { child = await start({ port, container, volume, mountTarget, env }); }
    catch (e) { emit({ phase: "container", status: "error", message: `容器启动失败：${e.message}` }); return { ok: false, reason: "container_start_failed" }; }
    if (!child) {
      emit({ phase: "container", status: "error", message: "容器启动失败" });
      return { ok: false, reason: "container_start_failed" };
    }
  }

  // 4) Health
  emit({ phase: "health", status: "running", message: "等待容器就绪…" });
  const healthy = await waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? "Docker cicy-code 已就绪 🎉" : `容器起来了但 :${port} 还没响应,稍等或点重试` });
  return { ok: healthy, container };
}

// Windows 侧「连 127.0.0.1 都 connect EADDRINUSE」= 动态 TCP 端口被占满 / 被 Hyper-V(winnat)
// 的保留段吞掉。软件可修:重启 winnat 释放保留段 + 把动态端口范围重设为默认(49152-65535)。
// 一次 UAC,结果写文件回读。返回 { ok, detail }。
function elevatedTcpRepair({ emit } = {}) {
  return new Promise(async (resolve) => {
    if (process.platform !== "win32") return resolve({ ok: false, detail: "win-only" });
    const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "cicy-desktop");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const ps1 = path.join(dir, "tcp-repair.ps1");
    const resultFile = path.join(dir, "tcp-repair.result.txt");
    try { fs.unlinkSync(resultFile); } catch {}
    const script = [
      '$ErrorActionPreference = "Continue"',
      `$R = "${resultFile.replace(/"/g, '""')}"`,
      'function Say($m) { Add-Content -Path $R -Value ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $m) }',
      '$S32 = Join-Path $env:SystemRoot "System32"; $NETSH = Join-Path $S32 "netsh.exe"; $NET = Join-Path $S32 "net.exe"',
      'Say "start admin=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(\'Administrators\'))"',
      'try { $d = (& $NETSH int ipv4 show dynamicport tcp | Out-String) -replace "\s+"," "; Say ("before: " + $d.Trim()) } catch {}',
      'try { $x = (& $NETSH int ipv4 show excludedportrange protocol=tcp | Out-String); $n = ([regex]::Matches($x, "^\s*\d+\s+\d+", "Multiline")).Count; Say ("excluded ranges: " + $n) } catch {}',
      'try { $tw = (& (Join-Path $S32 "netstat.exe") -ano | Select-String "TIME_WAIT").Count; Say ("TIME_WAIT: " + $tw) } catch {}',
      '& $NET stop winnat | Out-Null; Say ("net stop winnat exit=" + $LASTEXITCODE)',
      '& $NETSH int ipv4 set dynamicport tcp start=49152 num=16384 | Out-Null; Say ("set dynamicport tcp exit=" + $LASTEXITCODE)',
      '& $NETSH int ipv4 set dynamicport udp start=49152 num=16384 | Out-Null; Say ("set dynamicport udp exit=" + $LASTEXITCODE)',
      '& $NET start winnat | Out-Null; Say ("net start winnat exit=" + $LASTEXITCODE)',
      'try { $d = (& $NETSH int ipv4 show dynamicport tcp | Out-String) -replace "\s+"," "; Say ("after: " + $d.Trim()) } catch {}',
      'Say "DONE"',
    ].join("\r\n");
    try { fs.writeFileSync(ps1, "\uFEFF" + script, "utf8"); } catch (e) { return resolve({ ok: false, detail: `写提权脚本失败: ${e.message}` }); }
    const launched = await launchElevated("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1], { emit });
    if (!launched) return resolve({ ok: false, detail: "无法发起提权（UAC 被拒绝或不可用）" });
    const t0 = Date.now(); let lines = [];
    while (Date.now() - t0 < 3 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 3000));
      try { lines = fs.readFileSync(resultFile, "utf8").split(/\r?\n/).filter(Boolean); } catch {}
      if (lines.some((l) => /DONE/.test(l))) break;
      if (Date.now() - t0 > 90 * 1000 && lines.length === 0) break;
    }
    const detail = lines.map((l) => l.replace(/^\[[^\]]*\] /, "")).join(" | ");
    resolve({ ok: /set dynamicport tcp exit=0/.test(detail) && /net start winnat exit=0/.test(detail), detail: detail || "提权后 90 秒内没有任何进展（UAC 可能没有被点击「是」）" });
  });
}

module.exports = {
  elevatedTcpRepair,
  start, stop, stopContainer, restart, checkStatus, loadImage, loadImageFromTarball,
  downloadImageTarball, imagePresent, dockerOk, installDocker,
  bootstrap, probeHealth, readContainerToken, dockerDesktopExe, desktopDir, downloadsDir, imageTarballPath,
  launchElevated, elevatedWslSetup, modernWslInstalled, spawnProbe, wslFunctional, wslKernelPresent, wslExe, wslMissing, ensureWsl, virtualizationStatus,
  // platform-agnostic download/retry primitives, reused by native.js
  ensureDownloaded, curlDownload, withRetry, waitUntil, run, headSize,
  // image freshness (修「重建仍用旧镜像」—— 校验 OSS ETag 变了才重下重载)
  headETag, remoteImageEtag, readLoadedImageEtag, writeLoadedImageEtag, clearImageTarball,
};
