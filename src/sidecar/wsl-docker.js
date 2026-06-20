// Docker-版 cicy-code via WSL2 + Ubuntu + Docker Engine (主人选定方案 A).
//
// Instead of the heavy/fragile Docker Desktop GUI install, we run Docker Engine
// (Apache-2.0, no licensing) INSIDE a WSL2 Ubuntu distro and drive it with
// deterministic Linux commands — no UAC click-through, no whale-icon wait, no
// leftover-staging / PATH issues. WSL2 forwards localhost, so a container
// published on :8009 in Ubuntu is reachable at 127.0.0.1:8009 on Windows.
//
// Flow: ensure WSL2 → ensure Ubuntu distro → apt install docker.io → start
// dockerd → docker load (image tarball from ~/Downloads via /mnt/c) → docker run
// → health-probe :8009 from Windows. Every step checks-then-acts and is
// idempotent, so 重试 resumes.

const { execFile, execFileSync, spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const docker = require("./docker"); // shared: downloads, waitUntil, probeHealth, launchElevated, ensureWsl…

const DISTRO   = process.env.CICY_WSL_DISTRO || "Ubuntu";
const IMAGE    = process.env.CICY_DOCKER_IMAGE || "cicybot/cicy-code:latest";
// Ubuntu WSL rootfs from the Tsinghua TUNA mirror (CN-fast). We download it
// ourselves (real progress bar) and `wsl --import` it, instead of
// `wsl --install -d Ubuntu` (no parseable progress, needs the MS Store).
const ROOTFS_URL = process.env.CICY_WSL_ROOTFS_URL ||
  "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz";

function rootfsPath() { return path.join(docker.downloadsDir(), "ubuntu-jammy-wsl-rootfs.tar.gz"); }

// Run a bash command as root inside the distro. execFile (no host shell) → the
// command string is passed verbatim to `bash -lc`, so only bash-level quoting
// matters inside `cmd`.
function wslRun(cmd, { timeout = 60000, distro = DISTRO } = {}) {
  return new Promise((resolve, reject) => {
    execFile("wsl", ["-d", distro, "-u", "root", "--", "bash", "-lc", cmd],
      { timeout, windowsHide: true, maxBuffer: 1 << 26 },
      (err, stdout, stderr) => {
        if (err) { err.stdout = String(stdout || ""); err.stderr = String(stderr || ""); return reject(err); }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

// Like wslRun, but STREAMS each output line to the install drawer so the user
// (and the customer) watch the real install proceed — apt fetching/unpacking,
// `docker load` layers — instead of staring at a frozen spinner. Throttled so
// rapid output doesn't flood the log; resolves { stdout } with the full tail.
function wslRunStream(cmd, { emit, phase = "install-docker", timeout = 900000, distro = DISTRO } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl", ["-d", distro, "-u", "root", "--", "bash", "-lc", cmd], { windowsHide: true });
    let buf = "", tail = "", last = 0;
    const pump = (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        tail += line + "\n";
        const now = Date.now();
        if (emit && now - last > 350) { last = now; emit({ phase, status: "running", message: line.slice(0, 200) }); }
      }
    };
    child.stdout.on("data", pump);
    child.stderr.on("data", pump);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(Object.assign(new Error("timeout"), { stdout: tail })); }, timeout);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve({ stdout: tail }) : reject(Object.assign(new Error(`exit ${code}`), { stdout: tail })); });
  });
}

// Is `DISTRO` registered? `wsl -l -q` lists installed distros (UTF-16LE).
function distroInstalled(distro = DISTRO) {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("wsl", ["-l", "-q"], { timeout: 8000, windowsHide: true, encoding: "utf16le" });
    return String(out).split(/\r?\n/).map((s) => s.replace(/\0/g, "").trim()).filter(Boolean)
      .some((d) => d.toLowerCase() === distro.toLowerCase());
  } catch { return false; }
}

// Install the Ubuntu distro WITHOUT launching its interactive first-run setup
// (--no-launch). We always run commands as root afterwards, so no user account
// is needed. Elevated via the scheduled-task path (reliable on these machines).
async function installDistro({ emit } = {}) {
  // 1) Download the rootfs with a REAL progress bar (Tsinghua mirror, resumable).
  const dest = rootfsPath();
  await docker.ensureDownloaded(ROOTFS_URL, dest, null, { emit, phase: "install-docker", label: "下载 Ubuntu" });
  // 2) Ensure the WSL2 kernel exists (a feature-enable + reboot leaves the kernel
  //    component missing → `--import --version 2` errors). Best-effort, non-fatal.
  emit && emit({ phase: "install-docker", status: "running", message: "检查/更新 WSL2 内核…" });
  await new Promise((res) => execFile("wsl", ["--update", "--web-download"], { timeout: 180000, windowsHide: true }, () => res()));
  try { await new Promise((res) => execFile("wsl", ["--set-default-version", "2"], { timeout: 15000, windowsHide: true }, () => res())); } catch {}
  // 3) Import it as a WSL2 distro (creates the VHD under installDir; no MS Store,
  //    no interactive first-run — we run everything as root afterwards).
  emit && emit({ phase: "install-docker", status: "running", message: "导入 Ubuntu 到 WSL2…" });
  const installDir = path.join(process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local"), "cicy-ubuntu");
  try { fs.mkdirSync(installDir, { recursive: true }); } catch {}
  await new Promise((resolve, reject) => {
    execFile("wsl", ["--import", DISTRO, installDir, dest, "--version", "2"],
      { timeout: 600000, windowsHide: true },
      (err, _so, se) => err ? reject(Object.assign(err, { stderr: String(se || "") })) : resolve());
  });
}

// docker CLI present inside the distro?
async function dockerInstalled() {
  try { await wslRun("command -v docker >/dev/null 2>&1", { timeout: 8000 }); return true; }
  catch { return false; }
}

// Install Docker Engine (docker.io) inside the distro.
async function installDockerEngine({ emit } = {}) {
  emit && emit({ phase: "install-docker", status: "running", message: "在 Ubuntu 里安装 Docker（apt,几分钟,下面是实时进度）…" });
  await wslRunStream("apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io 2>&1", { emit, phase: "install-docker", timeout: 900000 });
}

// dockerd reachable inside the distro?
async function dockerEngineUp() {
  try { await wslRun("docker version --format '{{.Server.Version}}'", { timeout: 8000 }); return true; }
  catch { return false; }
}

// Start the Docker daemon (SysV service; docker.io ships an init script).
async function startEngine() {
  // `service docker start` works without systemd; the `|| dockerd &` keeps it
  // up on distros where the service script is absent.
  try { await wslRun("service docker start 2>/dev/null || (nohup dockerd >/var/log/cicy-dockerd.log 2>&1 &)", { timeout: 30000 }); } catch {}
}

// The cicy-code base image present inside the distro's Docker?
async function imagePresent() {
  try { await wslRun(`docker image inspect ${IMAGE} >/dev/null 2>&1`, { timeout: 10000 }); return true; }
  catch { return false; }
}

// Convert a Windows path (C:\Users\..\x) to its WSL /mnt/c/Users/../x form.
function toWslPath(winPath) {
  return String(winPath).replace(/^([A-Za-z]):[\\/]/, (_m, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

// docker load the (Windows-side) tarball into the distro's Docker + retag.
async function loadImage(winTarballPath, { emit } = {}) {
  emit && emit({ phase: "image", status: "loading", message: "正在导入镜像到 Docker（较大,约 1-3 分钟,下面是实时进度）…" });
  const p = toWslPath(winTarballPath);
  const { stdout } = await wslRunStream(`docker load -i "${p}"`, { emit, phase: "image", timeout: 600000 });
  const m = String(stdout).match(/Loaded image:\s*(\S+)/i);
  if (m && m[1] !== IMAGE) { try { await wslRun(`docker tag ${m[1]} ${IMAGE}`, { timeout: 15000 }); } catch {} }
}

// HTTP /health probe on 127.0.0.1:port from Windows — WSL2 forwards localhost,
// so a container published on :port is reachable here. Reuse docker.js's probe.
const probeHealth = docker.probeHealth;

// Start (or adopt) the container on :port inside the distro.
async function runContainer({ port = 8009, container = "cicy-code-docker", volume = "cicy-team", env = {} } = {}) {
  if (await probeHealth(port)) return { adopted: true };
  // Replace any stale same-named container.
  try { await wslRun(`docker rm -f ${container}`, { timeout: 20000 }); } catch {}
  const envArgs = Object.entries(env || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `-e ${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  const cmd = `docker run -d --name ${container} --restart unless-stopped -p ${port}:8008 -v ${volume}:/home/cicy ${envArgs} ${IMAGE}`;
  await wslRun(cmd, { timeout: 60000 });
  return { started: true };
}

// Read the container's own api_token (its volume-persisted global.json) for the
// team registration — the host token is a different credential.
async function readContainerToken(port = 8009) {
  try {
    const { stdout } = await wslRun(`docker ps --filter "publish=${port}" --format '{{.Names}}'`, { timeout: 10000 });
    const name = stdout.trim().split("\n")[0];
    if (!name) return "";
    const r = await wslRun(`docker exec ${name} cat /home/cicy/cicy-ai/global.json`, { timeout: 10000 });
    return JSON.parse(r.stdout).api_token || "";
  } catch { return ""; }
}

// Composite status for the card.
async function status(port = 8009) {
  const wsl = !docker.wslMissing();
  const distro = wsl && distroInstalled();
  const engineUp = distro && (await dockerEngineUp());
  const running = engineUp && (await probeHealth(port));
  return { wsl, distro, engineUp, running };
}

// Full bootstrap. Honest progress + honest terminal (ok only when :port healthy).
async function bootstrap({ onProgress, port = 8009, container = "cicy-code-docker", volume = "cicy-team", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };

  // 1) WSL2 platform
  if (docker.wslMissing()) {
    const w = await docker.ensureWsl({ emit });
    if (w.needsReboot) { emit({ phase: "done", status: "reboot", message: "WSL2 正在安装——请【重启 Windows】后回来点「重试」继续。" }); return { ok: false, reason: "wsl_reboot_required" }; }
  }

  // 2) Ubuntu distro
  if (!distroInstalled()) {
    try { await installDistro({ emit }); } catch (e) { emit({ phase: "done", status: "error", message: `Ubuntu 安装失败：${e.message}（点重试）` }); return { ok: false, reason: "distro_install_failed" }; }
    const t0 = Date.now();
    const ok = await docker.waitUntil(() => distroInstalled(), { totalMs: 600000, everyMs: 5000, onTick: () => emit({ phase: "install-docker", status: "running", message: `正在下载/注册 Ubuntu…（已 ${Math.round((Date.now() - t0) / 1000)}s,首次较慢请耐心）` }) });
    if (!ok) { emit({ phase: "done", status: "error", message: "Ubuntu 还没装好——稍等或点「重试」" }); return { ok: false, reason: "distro_not_ready" }; }
  }

  // 3) Docker Engine inside Ubuntu
  if (!(await dockerInstalled())) {
    try { await installDockerEngine({ emit }); } catch (e) { emit({ phase: "done", status: "error", message: `Docker 安装失败：${e.message}（点重试）` }); return { ok: false, reason: "docker_install_failed" }; }
  }

  // 4) dockerd up
  if (!(await dockerEngineUp())) {
    emit({ phase: "install-docker", status: "running", message: "启动 Docker 引擎…" });
    await startEngine();
    const up = await docker.waitUntil(dockerEngineUp, { totalMs: 60000, everyMs: 3000 });
    if (!up) { emit({ phase: "done", status: "error", message: "Docker 引擎没起来——点「重试」" }); return { ok: false, reason: "dockerd_not_up" }; }
  }
  emit({ phase: "install-docker", status: "done", message: "Docker 环境就绪" });

  // 5) Base image
  if (!(await imagePresent())) {
    let tarball;
    try { tarball = await docker.downloadImageTarball({ emit }); }
    catch (e) { emit({ phase: "done", status: "error", message: `镜像下载失败：${e.message}（点重试续传）` }); return { ok: false, reason: "image_download_failed" }; }
    try { await loadImage(tarball, { emit }); emit({ phase: "image", status: "done", message: "镜像就绪" }); }
    catch (e) { emit({ phase: "done", status: "error", message: `镜像导入失败：${e.message}（点重试）` }); return { ok: false, reason: "image_load_failed" }; }
  } else {
    emit({ phase: "image", status: "skip", message: "镜像已就绪，跳过" });
  }

  // 6) Container
  if (!(await probeHealth(port))) {
    emit({ phase: "container", status: "running", message: "启动 cicy-code 容器…" });
    try { await runContainer({ port, container, volume, env }); }
    catch (e) { emit({ phase: "done", status: "error", message: `容器启动失败：${e.message}（点重试）` }); return { ok: false, reason: "container_start_failed" }; }
  }

  // 7) Health — the ONLY path to ok:true.
  emit({ phase: "health", status: "running", message: "等待 cicy-code 就绪…" });
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? "Docker cicy-code 已就绪 🎉" : `容器起来了但 :${port} 还没响应——稍等或点「重试」` });
  return { ok: healthy, container };
}

// Lifecycle (card ⋯ menu).
async function restart({ container = "cicy-code-docker", port = 8009 } = {}) {
  await startEngine();
  await wslRun(`docker restart ${container}`, { timeout: 60000 });
  return await docker.waitUntil(() => probeHealth(port), { totalMs: 60000, everyMs: 2000 });
}
async function stop({ container = "cicy-code-docker" } = {}) {
  try { await wslRun(`docker stop ${container}`, { timeout: 30000 }); } catch {}
}
async function upgrade({ onProgress, port = 8009, container = "cicy-code-docker", volume = "cicy-team", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  if (!(await dockerEngineUp())) { await startEngine(); if (!(await dockerEngineUp())) { emit({ phase: "done", status: "error", message: "Docker 引擎未运行" }); return { ok: false, reason: "dockerd_not_up" }; } }
  let tarball;
  try { tarball = await docker.downloadImageTarball({ emit }); await loadImage(tarball, { emit }); emit({ phase: "image", status: "done", message: "镜像已更新" }); }
  catch (e) { emit({ phase: "done", status: "error", message: `升级失败：${e.message}` }); return { ok: false, reason: "image_failed" }; }
  emit({ phase: "container", status: "running", message: "用新镜像重建容器…" });
  try { await stop({ container }); await runContainer({ port, container, volume, env }); }
  catch (e) { emit({ phase: "done", status: "error", message: `容器启动失败：${e.message}` }); return { ok: false, reason: "container_start_failed" }; }
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? "升级完成 🎉" : `启动了但 :${port} 还没响应` });
  return { ok: healthy };
}

module.exports = {
  bootstrap, status, restart, stop, upgrade, runContainer, readContainerToken,
  distroInstalled, dockerInstalled, dockerEngineUp, imagePresent, probeHealth, wslRun,
};
