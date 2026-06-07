// Windows sidecar backend: run cicy-code inside a Docker container.
//
// Platform split (2026-06): mac/linux start cicy-code locally via `npx
// cicy-code` (see cicy-code.js); Windows runs it in Docker Desktop instead.
// The base-env image's entrypoint installs cicy-code from npm at container
// startup, so the image is version-independent. If the image isn't present
// locally it's loaded from R2 (CN-friendly, no Docker Hub pull):
//   https://r2.deepfetch.de5.net/docker/cicy-code-latest.tar.gz
//
// The container maps :8008 and persists ~/cicy-ai in a named volume.
const { execFile, spawn } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const IMAGE     = process.env.CICY_DOCKER_IMAGE || "cicybot/cicy-code:latest";
const R2_TARBALL = process.env.CICY_DOCKER_URL  || "https://r2.deepfetch.de5.net/docker/cicy-code-latest.tar.gz";
const CONTAINER = process.env.CICY_DOCKER_CONTAINER || "cicy-code";
const VOLUME    = process.env.CICY_DOCKER_VOLUME || "cicy-ai-data";
// Docker Desktop installer (Windows). Direct from docker.com, with a COS mirror
// fallback for CN where docker.com is slow/blocked. Override via env if needed.
const DOCKER_DESKTOP_URL = process.env.CICY_DOCKER_DESKTOP_URL
  || "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
const DOCKER_DESKTOP_MIRROR = process.env.CICY_DOCKER_DESKTOP_MIRROR
  || "https://cicy-1372193042.cos.ap-shanghai.myqcloud.com/binaries/DockerDesktopInstaller.exe";
// CICY_* env vars forwarded into the container (team onboarding, version pin…).
const PASS_ENV = ["CICY_TEAM_TOKEN", "CICY_CODE_VERSION", "NPM_REGISTRY", "CICY_NPM_REGISTRY", "CICY_AGENTS", "ENABLE_CDN", "CICY_CLOUDFLARED_TOKEN"];

function run(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stdout = String(stdout || ""); err.stderr = String(stderr || ""); return reject(err); }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function dockerOk() {
  try { await run(["version", "--format", "{{.Server.Version}}"], { timeout: 8000 }); return true; }
  catch { return false; }
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
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
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
    const req = lib.request(url, { method: "HEAD", timeout: 15000 }, (res) => {
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

// Download `url`→`dest` but: SKIP if the file is already complete, RESUME if it's
// a partial, retry with progress, fall back to `mirror`. This is the core of the
// user's "下载了就不重复下载 / 步骤走过的不要再走".
async function ensureDownloaded(url, dest, mirror, { emit, phase, label } = {}) {
  const expected = (await headSize(url)) || (mirror ? await headSize(mirror) : 0);
  let have = 0; try { have = fs.statSync(dest).size; } catch {}
  if (expected > 0 && have === expected) {
    emit && emit({ phase, status: "skip", message: `${label}：已下载，跳过`, progress: 100 });
    return dest;
  }
  const sources = mirror ? [url, mirror] : [url];
  return withRetry(async (attempt) => {
    const src = sources[Math.min(attempt - 1, sources.length - 1)];
    await download(src, dest, {
      resume: true,
      onProgress: ({ received, total }) => {
        const pct = total ? Math.round((received / total) * 100) : 0;
        emit && emit({ phase, status: "running", message: label, progress: pct, received, total });
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

async function loadImage({ emit } = {}) {
  // STABLE temp name (no pid) so a re-run reuses an existing partial/complete
  // tarball instead of starting over.
  const tmp = path.join(os.tmpdir(), "cicy-code-latest.tar.gz");
  await ensureDownloaded(R2_TARBALL, tmp, null, { emit, phase: "image", label: "下载镜像" });
  emit && emit({ phase: "image", status: "running", message: "docker load…", progress: 100 });
  console.log(`[docker-sidecar] docker load…`);
  await run(["load", "-i", tmp], { timeout: 300000 });
  // Only delete AFTER a successful load — a failed load keeps the tarball so the
  // next attempt skips the re-download. (imagePresent() gates re-entry anyway.)
  try { fs.unlinkSync(tmp); } catch {}
}

async function checkStatus() {
  const installed = await dockerOk();
  return { installed, imagePresent: installed ? await imagePresent() : false };
}

// Start the container. Returns a sidecar child token { docker:true, container,
// id } or null when Docker isn't ready (homepage guides the user to install
// Docker Desktop).
async function start({ port = 8008 } = {}) {
  if (!(await dockerOk())) {
    console.warn("[docker-sidecar] Docker not available — homepage will guide install");
    return null;
  }
  if (!(await imagePresent())) {
    try { await loadImage(); }
    catch (e) { console.warn(`[docker-sidecar] image load failed: ${e.message}`); return null; }
  }
  // Replace any stale container of the same name.
  try { await run(["rm", "-f", CONTAINER]); } catch {}

  const args = [
    "run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
    "-p", `${port}:8008`,
    "-v", `${VOLUME}:/home/cicy/cicy-ai`,
  ];
  for (const k of PASS_ENV) {
    if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  }
  args.push(IMAGE);

  const { stdout } = await run(args, { timeout: 60000 });
  const id = stdout.trim().slice(0, 12);
  console.log(`[docker-sidecar] started container ${CONTAINER} (${id}) on :${port}`);
  return { docker: true, container: CONTAINER, id };
}

async function stop() {
  try { await run(["rm", "-f", CONTAINER]); } catch {}
}

// Download + run the Docker Desktop installer (Windows). The installer needs
// admin → Windows shows a UAC prompt the user accepts; first run may want a
// reboot. We download (skip/resume aware) then launch silent and return.
async function installDocker({ emit } = {}) {
  const e = emit || (() => {});
  const dest = path.join(os.tmpdir(), "DockerDesktopInstaller.exe");
  e({ phase: "install-docker", status: "running", message: "下载 Docker Desktop 安装包…", progress: 0 });
  await ensureDownloaded(DOCKER_DESKTOP_URL, dest, DOCKER_DESKTOP_MIRROR, {
    emit, phase: "install-docker", label: "下载 Docker Desktop",
  });
  e({ phase: "install-docker", status: "running", message: "安装 Docker Desktop（请在弹出的授权框点「是」，装完可能需重启）…" });
  await new Promise((resolve) => {
    try {
      const child = spawn(dest, ["install", "--quiet", "--accept-license"], {
        windowsHide: false, detached: true, stdio: "ignore",
      });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    } catch { resolve(); }
  });
}

// One-shot, idempotent, resumable bootstrap of the whole local-team stack on
// Windows: install Docker (if missing) → load the base image (if missing) →
// start the container → wait for :8008. Every step CHECKS first and SKIPS if
// already done, emits coarse phase events + byte progress, and the downloads
// resume. Safe to call again after a failure — it picks up where it left off.
async function bootstrap({ onProgress, port = 8008 } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };

  // 1) Docker present?
  if (await dockerOk()) {
    emit({ phase: "install-docker", status: "skip", message: "Docker 已安装，跳过" });
  } else {
    await installDocker({ emit });
    emit({ phase: "install-docker", status: "running", message: "等待 Docker 启动（如需授权/重启，完成后会自动继续）…" });
    const up = await waitUntil(dockerOk, { totalMs: 900000, everyMs: 6000 });
    if (!up) {
      emit({ phase: "install-docker", status: "error", message: "Docker 还没就绪——装好后启动 Docker Desktop，再点「重试」即可（已完成的步骤不会重来）" });
      return { ok: false, reason: "docker_not_ready" };
    }
    emit({ phase: "install-docker", status: "done", message: "Docker 就绪" });
  }

  // 2) Base image present?
  if (await imagePresent()) {
    emit({ phase: "image", status: "skip", message: "镜像已就绪，跳过" });
  } else {
    try {
      await loadImage({ emit });
      emit({ phase: "image", status: "done", message: "镜像就绪" });
    } catch (e) {
      emit({ phase: "image", status: "error", message: `镜像加载失败：${e.message}（点重试,下载会续传）` });
      return { ok: false, reason: "image_load_failed" };
    }
  }

  // 3) Container — start() already reuses/replaces by name.
  emit({ phase: "container", status: "running", message: "启动 cicy-code 容器…" });
  const child = await start({ port });
  if (!child) {
    emit({ phase: "container", status: "error", message: "容器启动失败" });
    return { ok: false, reason: "container_start_failed" };
  }

  // 4) Health
  emit({ phase: "health", status: "running", message: "等待本地团队就绪…" });
  const healthy = await waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? "本地团队已就绪 🎉" : "容器起来了但 :8008 还没响应,稍等或点重试" });
  return { ok: healthy, container: CONTAINER };
}

module.exports = { start, stop, checkStatus, loadImage, imagePresent, dockerOk, installDocker, bootstrap, probeHealth };
