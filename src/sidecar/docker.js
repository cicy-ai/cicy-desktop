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
async function ensureDownloaded(url, dest, mirror, { emit, phase, label, freshOnIncomplete = false } = {}) {
  const expected = (await headSize(url)) || (mirror ? await headSize(mirror) : 0);
  let have = 0; try { have = fs.statSync(dest).size; } catch {}
  // Complete file already on disk → skip (主人: 完整的 exe/镜像包就别重下了；用户
  // 自己下到 ~/Downloads 同名文件也走这条直接复用).
  if (expected > 0 && have === expected) {
    emit && emit({ phase, status: "skip", message: `${label}：已下载，跳过`, progress: 100, received: have, total: expected, url, dest });
    return dest;
  }
  // A partial left by a PREVIOUS, interrupted/restarted session can be corrupt;
  // when freshOnIncomplete, delete it and start clean rather than range-resuming
  // onto a possibly-bad file (主人: 下载被重启打断的残包要删掉重下). Within THIS
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
    // 断点续传 (主人): resume the partial via a Range request instead of
    // restarting from 0 — efficient on a flaky network. The post-download size
    // check below + loadImage's load-failure cleanup guard against a bad partial.
    await download(src, dest, {
      resume: true,
      onProgress: ({ received, total }) => {
        const pct = total ? Math.round((received / total) * 100) : 0;
        if (pct === lastPct) return;
        lastPct = pct;
        // `url` = source, `dest` = local target path (主人: UI 显示下载目录; lets the
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

// The R2 image tarball downloads to ~/Downloads (主人: docker image 下到
// ~/Downloads — visible, like the Docker installer on the Desktop). STABLE name
// (no pid) so a re-run reuses an existing partial/complete file (resume-friendly
// on a flaky network).
// Both the Docker installer AND the image tarball download here (主人: 都下到
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

// Download the R2 base-env image tarball (no docker needed yet). Split out of
// loadImage so bootstrap can run this IN PARALLEL with the Docker Desktop
// install (主人: 装 Docker 的同时下载 R2 镜像). Returns the tarball path.
async function downloadImageTarball({ emit } = {}) {
  const dest = imageTarballPath();
  await ensureDownloaded(R2_TARBALL, dest, null, { emit, phase: "image", label: "下载镜像" });
  return dest;
}

// `docker load` an already-downloaded tarball + re-tag to IMAGE. Needs the
// daemon up, so this runs AFTER Docker is ready (主人: 再导入 docker).
async function loadImageFromTarball(tmp, { emit } = {}) {
  emit && emit({ phase: "image", status: "running", message: "docker load…", progress: 100 });
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
  // Keep the tarball in ~/Downloads (主人: 下到 Downloads) — it's a visible,
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

// Resolve the user's Desktop folder (主人指令: docker-desktop.exe 下到 Desktop).
// %USERPROFILE%\Desktop is the canonical location; OneDrive redirection is rare
// on the target machines and the file is only a transient installer anyway.
function desktopDir() {
  return path.join(process.env["USERPROFILE"] || os.homedir(), "Desktop");
}

// Start the container. Returns a sidecar child token { docker:true, container,
// id } or null when Docker isn't ready (homepage guides the user to install
// Docker Desktop). `container`/`volume` are parameterized so a SECOND instance
// (the Docker-版 cicy-code on :8009) can run alongside the native local one
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
  // Docker-版 instance passes /home/cicy to persist the WHOLE cicy home (主人:
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
// the Desktop folder so the user can see/keep the installer (主人指令).
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

// Run an admin-manifest exe (Docker Desktop Installer) ELEVATED. A plain
// child_process.spawn of a requireAdministrator exe from a non-elevated process
// fails with ERROR_ELEVATION_REQUIRED (740) and never shows UAC — which is why
// the installer "downloaded but didn't auto-install". ShellExecute with the
// "runas" verb is the only way to raise the UAC prompt + elevate. We drive it
// via VBScript/cscript because PowerShell is blocked by 360 on these machines.
// ShellExecute returns immediately (installer runs in the background); bootstrap
// then polls dockerOk(). Falls back to a direct spawn if cscript is unavailable.
function launchElevated(exe, args, { emit } = {}) {
  return new Promise((resolve) => {
    try {
      const vbs = path.join(os.tmpdir(), "cicy-docker-elevate.vbs");
      const argStr = args.join(" ").replace(/"/g, '""');
      const exeEsc = String(exe).replace(/"/g, '""');
      // chr(34) = a literal double-quote inside the VBS string literals.
      fs.writeFileSync(vbs,
        `Set s = CreateObject("Shell.Application")\r\n` +
        `s.ShellExecute "${exeEsc}", "${argStr}", "", "runas", 1\r\n`,
        "utf8");
      const child = spawn("cscript", ["//nologo", vbs], { windowsHide: true, detached: true, stdio: "ignore" });
      let done = false;
      const fin = (ok) => { if (done) return; done = true; resolve(ok); };
      child.on("error", () => {
        // cscript missing/blocked → best-effort direct spawn (works if elevated).
        try {
          emit && emit({ phase: "install-docker", status: "running", message: "提权脚本不可用，尝试直接启动安装包…" });
          const c2 = spawn(exe, args, { windowsHide: false, detached: true, stdio: "ignore" });
          c2.on("error", () => fin(false));
          c2.on("spawn", () => fin(true));
          c2.on("exit", () => fin(true));
        } catch { fin(false); }
      });
      child.on("exit", () => fin(true));
    } catch { resolve(false); }
  });
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

  // 1) Docker present?
  if (await dockerOk()) {
    emit({ phase: "install-docker", status: "skip", message: "Docker 已安装，跳过" });
  } else if (dockerDesktopExe()) {
    // Installed but the daemon is down — just launch Docker Desktop, never
    // re-download/re-run the installer (主人: 装了就别再下 Docker Desktop 了).
    emit({ phase: "install-docker", status: "running", message: "Docker 已安装，正在启动 Docker Desktop…" });
    if (needImage) imgDl = downloadImageTarball({ emit }).catch((e) => { emit({ phase: "image", status: "error", message: `镜像下载失败：${e.message}` }); return null; });
    startDockerDesktop();
    const up = await waitUntil(dockerOk, { totalMs: 300000, everyMs: 5000 });
    if (!up) {
      emit({ phase: "install-docker", status: "error", message: "Docker Desktop 启动超时——手动打开它等图标变绿，再点「重试」" });
      return { ok: false, reason: "docker_not_ready" };
    }
    emit({ phase: "install-docker", status: "done", message: "Docker 就绪" });
  } else {
    // Docker missing → download the R2 image IN PARALLEL with the installer
    // running + the daemon coming up (主人: 装 Docker 的同时下载 R2 镜像).
    if (needImage) imgDl = downloadImageTarball({ emit }).catch((e) => { emit({ phase: "image", status: "error", message: `镜像下载失败：${e.message}` }); return null; });
    await installDocker({ emit, dest: installDest });
    // A silent install doesn't auto-launch the daemon — explicitly start Docker
    // Desktop once its exe lands so the user doesn't have to (主人: 安装启动有问题).
    emit({ phase: "install-docker", status: "running", message: "启动 Docker Desktop…" });
    const launched = await waitUntil(() => { if (dockerDesktopExe()) { startDockerDesktop(); return true; } return false; }, { totalMs: 120000, everyMs: 5000 });
    emit({ phase: "install-docker", status: "running", message: launched ? "等待 Docker 引擎就绪（首次启动较慢，如弹授权/重启请确认）…" : "等待 Docker 安装完成…" });
    const up = await waitUntil(dockerOk, { totalMs: 900000, everyMs: 6000 });
    if (!up) {
      emit({ phase: "install-docker", status: "error", message: "Docker 还没就绪——装好后启动 Docker Desktop，再点「重试」即可（已完成的步骤不会重来）" });
      return { ok: false, reason: "docker_not_ready" };
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
      emit({ phase: "image", status: "running", message: "导入 Docker 镜像…", progress: 100 });
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

module.exports = {
  start, stop, stopContainer, restart, checkStatus, loadImage, loadImageFromTarball,
  downloadImageTarball, imagePresent, dockerOk, installDocker,
  bootstrap, probeHealth, readContainerToken, dockerDesktopExe, desktopDir, downloadsDir, imageTarballPath,
  // platform-agnostic download/retry primitives, reused by native.js
  ensureDownloaded, withRetry, waitUntil, run,
};
