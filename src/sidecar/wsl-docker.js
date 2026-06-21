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

// Dedicated distro name — NEVER reuse/clobber a user's own "Ubuntu" distro.
const DISTRO   = process.env.CICY_WSL_DISTRO || "cicy-code-wsl";
const IMAGE    = process.env.CICY_DOCKER_IMAGE || "cicybot/cicy-code:latest";
// PRE-BAKED WSL rootfs (built in CI, .github/workflows/build-wsl-package.yml):
// Ubuntu 22.04 + Docker Engine + the cicy-code image already loaded into
// /var/lib/docker, with dockerd auto-start via /etc/wsl.conf. We just download
// it (Aliyun OSS, CN-fast ~2.7MB/s) and `wsl --import` it — so the bootstrap's
// apt-install + image download/load steps are already done inside the tarball
// (their checks see docker present + image present and SKIP). ~444MB.
const ROOTFS_URL = process.env.CICY_WSL_ROOTFS_URL ||
  "https://cicy-1372193042-cn.oss-cn-shanghai.aliyuncs.com/rootfs/cicy-wsl-latest.tar.gz";

function rootfsPath() { return path.join(docker.downloadsDir(), "cicy-wsl-rootfs.tar.gz"); }
// WSL2 kernel update package (the small ~17MB MSI behind aka.ms/wsl2kernel).
const KERNEL_MSI_URL = process.env.CICY_WSL_KERNEL_URL || "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi";

// Install the WSL2 kernel component (idempotent — msiexec on an already-present
// kernel is a fast no-op). Streams a progress bar; non-fatal on download failure
// so we still attempt the import (the kernel may already be there).
async function ensureWslKernel({ emit } = {}) {
  const msi = path.join(docker.downloadsDir(), "wsl_update_x64.msi");
  try { await docker.ensureDownloaded(KERNEL_MSI_URL, msi, null, { emit, phase: "install-docker", label: "下载 WSL2 内核" }); }
  catch (e) { emit && emit({ phase: "install-docker", status: "running", message: `WSL2 内核下载失败:${e.message}（尝试继续）` }); return; }
  emit && emit({ phase: "install-docker", status: "running", message: "安装 WSL2 内核组件…" });
  await docker.launchElevated("msiexec", ["/i", msi, "/qn", "/norestart"], { emit });
  await new Promise((r) => setTimeout(r, 8000)); // let msiexec register the kernel
}

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
// Raw `wsl --import` of the rootfs as an ISOLATED v2 distro.
function importTarball(dest, installDir) {
  return new Promise((resolve, reject) => {
    execFile("wsl", ["--import", DISTRO, installDir, dest, "--version", "2"],
      { timeout: 600000, windowsHide: true },
      (err, _so, se) => { if (err) { err.stderr = String(se || ""); return reject(err); } resolve(); });
  });
}

async function installDistro({ emit } = {}) {
  // 1) Download the PRE-BAKED rootfs (Ubuntu+Docker+image baked in, ~444MB) with
  //    a real progress bar. curl is ~10× faster than node's downloader on OSS.
  const dest = rootfsPath();
  try { await docker.curlDownload(ROOTFS_URL, dest, { emit, phase: "image", label: "下载运行环境" }); }
  catch (e) {
    emit && emit({ phase: "image", status: "running", message: `下载器异常(${e.message}),改用备用下载…` });
    await docker.ensureDownloaded(ROOTFS_URL, dest, null, { emit, phase: "image", label: "下载运行环境" });
  }
  // 2) Import as an ISOLATED WSL2 distro: its OWN VHDX under a dedicated dir, so
  //    it never touches the user's existing distros. `--version 2` sets just THIS
  //    distro to v2 — we do NOT run `--set-default-version` (that would change the
  //    user's global default). The WSL2 kernel is shared; we install it ONLY when
  //    import actually fails for lack of it (never downgrade an existing kernel).
  const installDir = path.join(process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local"), "cicy-code-wsl");
  try { fs.mkdirSync(installDir, { recursive: true }); } catch {}
  emit && emit({ phase: "container", status: "running", message: "导入运行环境到 WSL2…" });
  try {
    await importTarball(dest, installDir);
  } catch (e) {
    // Most likely the shared WSL2 kernel component is missing — install it
    // (idempotent) and retry once.
    emit && emit({ phase: "container", status: "running", message: "需要 WSL2 内核,正在安装后重试…" });
    await ensureWslKernel({ emit });
    await importTarball(dest, installDir);
  }
  // 3) Free the ~444MB package now that the distro has everything.
  try { fs.unlinkSync(dest); } catch {}
}

// docker CLI present inside the distro?
async function dockerInstalled() {
  try { await wslRun("command -v docker >/dev/null 2>&1", { timeout: 8000 }); return true; }
  catch { return false; }
}

// Install Docker Engine (docker.io) inside the distro.
async function installDockerEngine({ emit } = {}) {
  emit && emit({ phase: "install-docker", status: "running", message: "在 Ubuntu 里安装 Docker（apt,几分钟,下面是实时进度）…" });
  // Point apt at the Tsinghua TUNA mirror (CN-fast; archive.ubuntu.com is slow
  // from CN) WITH the universe component (docker.io lives there). DPkg::Lock::
  // Timeout waits out the first-boot apt locks instead of failing with exit 100.
  const M = process.env.CICY_APT_MIRROR || "https://mirrors.tuna.tsinghua.edu.cn/ubuntu/";
  const setSources =
    `{ echo 'deb ${M} jammy main restricted universe multiverse'; ` +
    `echo 'deb ${M} jammy-updates main restricted universe multiverse'; ` +
    `echo 'deb ${M} jammy-security main restricted universe multiverse'; } > /etc/apt/sources.list`;
  await wslRunStream(
    `${setSources} && apt-get -o DPkg::Lock::Timeout=300 update && ` +
    `DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y docker.io 2>&1`,
    { emit, phase: "install-docker", timeout: 900000 });
}

// dockerd reachable inside the distro?
async function dockerEngineUp() {
  try { await wslRun("docker version --format '{{.Server.Version}}'", { timeout: 8000 }); return true; }
  catch { return false; }
}

// Start the Docker daemon inside WSL2. Modern docker.io (29.x) ships ONLY a
// systemd unit (no SysV init → `service docker start` says "unrecognized
// service"), and WSL distros have no systemd by default. So we launch dockerd
// directly. Two WSL2-specific prerequisites, both verified on a clean machine:
//   • iptables must use the LEGACY backend (Ubuntu defaults to nft, which
//     dockerd can't drive in WSL2 → daemon fails to set up networking).
//   • run dockerd detached and wait for /var/run/docker.sock.
async function startEngine() {
  // Up to 3 clean attempts: on a cold first boot dockerd can die mid-init (e.g.
  // networking not ready yet) and only succeed on a fresh relaunch — that race
  // was the main "一次装不上、要点几次重试" culprit. Each attempt clears stale
  // runtime files, (re)launches dockerd, and waits for the socket; between
  // attempts we hard-kill any half-dead daemon so the next launch is clean.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await wslRun(
        "update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1; " +
        "update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1; " +
        // A pre-baked rootfs (docker export after an inner dind dockerd) can ship a
        // STALE /var/run/docker.{pid,sock}: a fresh dockerd then refuses to start
        // ("pid file found, ensure docker is not running"). Clear them when dockerd
        // is NOT already running — that was the 烤制包「引擎没起来」failure.
        "if ! pgrep dockerd >/dev/null 2>&1; then rm -f /var/run/docker.pid /run/docker.pid /var/run/docker.sock /run/docker.sock; fi; " +
        "pgrep dockerd >/dev/null 2>&1 || (nohup dockerd >/var/log/cicy-dockerd.log 2>&1 &); " +
        // First boot of a freshly-imported distro: cold WSL2 VM + large pre-baked
        // /var/lib/docker → give it longer than 20s.
        "for i in $(seq 1 40); do [ -S /var/run/docker.sock ] && docker version >/dev/null 2>&1 && break; sleep 1; done",
        { timeout: 60000 });
    } catch {}
    if (await dockerEngineUp()) return true;
    // Failed: kill the half-dead daemon + clear runtime files for a clean retry.
    try { await wslRun("pkill -9 dockerd 2>/dev/null; rm -f /var/run/docker.pid /run/docker.pid /var/run/docker.sock /run/docker.sock; sleep 1", { timeout: 15000 }); } catch {}
  }
  return false;
}

// Tail dockerd's log so a "引擎没起来" failure is diagnosable instead of blind.
async function dockerdLogTail() {
  try {
    const { stdout } = await wslRun(
      "tail -n 25 /var/log/cicy-dockerd.log 2>/dev/null || tail -n 25 /var/log/dockerd.log 2>/dev/null",
      { timeout: 8000 });
    return String(stdout || "").trim();
  } catch { return ""; }
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
//
// We do NOT use --network host (it shares the distro's whole network namespace,
// exposing every container port — sshd:22, cron, etc. — and offers no
// isolation). Instead publish a single mapped port:
//   • CICY_PUBLIC=1 makes cicy-code bind 0.0.0.0:8008 INSIDE the container
//     (it binds 127.0.0.1 by default, which docker-proxy can't reach).
//   • -p 127.0.0.1:<port>:8008 pins the host side to loopback, so it's never
//     network-exposed; the api_token gates access. WSL2's localhost relay then
//     forwards the distro's 127.0.0.1:<port> to Windows 127.0.0.1:<port>.
// Only :<port> is published — sshd/cron stay inside the container's own netns.
async function runContainer({ port = 8009, container = "cicy-code-docker", volume = "cicy-team", env = {} } = {}) {
  if (await probeHealth(port)) return { adopted: true };
  // Replace any stale same-named container.
  try { await wslRun(`docker rm -f ${container}`, { timeout: 20000 }); } catch {}
  const envArgs = Object.entries(env || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `-e ${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  const cmd = `docker run -d --name ${container} --restart unless-stopped -p 127.0.0.1:${port}:8008 -e CICY_PUBLIC=1 -v ${volume}:/home/cicy ${envArgs} ${IMAGE}`;
  await wslRun(cmd, { timeout: 60000 });
  return { started: true };
}

// Read the container's OWN api_token (its volume-persisted global.json). This is
// the ONLY correct credential for :8009 — the host's 8008 token is different and
// 8009 rejects it. Retries because right after start the entrypoint may not have
// written global.json yet; returns "" only if it truly can't be read (callers
// must then NOT open with a wrong/host token — that strands the user at login).
async function readContainerToken(port = 8009, container = "cicy-code-docker", volume = "cicy-team") {
  for (let attempt = 1; attempt <= 5; attempt++) {
    // 1) Fast + reliable: read the volume-backed global.json straight from the
    //    distro fs. `docker exec` into a just-loaded/busy container is slow and
    //    frequently times out — and a timeout here was returning "" → callers
    //    fell back to the stale host token. The bind volume read never does that.
    try {
      const { stdout } = await wslRun(`cat /var/lib/docker/volumes/${volume}/_data/cicy-ai/global.json 2>/dev/null`, { timeout: 8000 });
      const m = String(stdout).match(/"api_token"\s*:\s*"(cicy_[A-Za-z0-9]+)"/);
      if (m) return m[1];
    } catch { /* not ready yet — retry */ }
    // 2) Fallback: exec into the container.
    try {
      const { stdout } = await wslRun(`docker exec ${container} cat /home/cicy/cicy-ai/global.json`, { timeout: 10000 });
      const tok = JSON.parse(stdout).api_token || "";
      if (tok) return tok;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "";
}

// Register a Windows logon task that starts dockerd in our distro on every
// logon — old inbox WSL ignores wsl.conf [boot], so without this :8009 is dead
// after a Windows reboot until the user clicks 启动. The container's
// --restart unless-stopped then brings cicy-code back automatically. Idempotent
// (start-dockerd.sh is `pgrep dockerd || dockerd`); /f overwrites a stale task.
function ensureAutostart() {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((res) => {
    const tr = `wsl.exe -d ${DISTRO} -u root -e /usr/local/sbin/start-dockerd.sh`;
    execFile("schtasks", ["/create", "/tn", "cicy-docker-autostart", "/tr", tr, "/sc", "onlogon", "/rl", "HIGHEST", "/f"],
      { windowsHide: true }, () => res());
  });
}

// Drop a desktop shortcut (folder icon) to the container's /home/cicy — i.e. the
// cicy-team volume on the distro — so the user can browse :8009's files from
// Windows Explorer. \\wsl$\<distro>\… is the UNC view of the WSL filesystem.
// Idempotent: CreateShortcut overwrites. Best-effort (errors swallowed).
function ensureDesktopShortcut(volume = "cicy-team") {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((res) => {
    const lnk = path.join(os.homedir(), "Desktop", "cicy-8009 文件.lnk");
    const target = `\\\\wsl$\\${DISTRO}\\var\\lib\\docker\\volumes\\${volume}\\_data`;
    const ps =
      `$w=New-Object -ComObject WScript.Shell;` +
      `$s=$w.CreateShortcut(${JSON.stringify(lnk)});` +
      `$s.TargetPath='explorer.exe';` +
      `$s.Arguments=${JSON.stringify(target)};` +
      `$s.IconLocation='imageres.dll,3';` +         // yellow Windows folder icon
      `$s.Description='cicy-code :8009 /home/cicy';` +
      `$s.Save()`;
    execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 15000 }, () => res());
  });
}

// Composite status for the card.
async function status(port = 8009) {
  const wsl = !docker.wslMissing();
  const distro = wsl && distroInstalled();
  const engineUp = distro && (await dockerEngineUp());
  const running = engineUp && (await probeHealth(port));
  return { wsl, distro, engineUp, running };
}

// Guard against overlapping bootstrap runs (double-click 重试 / re-entrancy):
// two concurrent runs would race on the same download file + apt lock → corrupt
// downloads and exit-100. A second caller just attaches to the in-flight run.
let _bootstrapInFlight = null;

// Full bootstrap. Honest progress + honest terminal (ok only when :port healthy).
async function bootstrap(opts = {}) {
  if (_bootstrapInFlight) {
    try { opts.onProgress && opts.onProgress({ phase: "install-docker", status: "running", message: "安装已在进行中,正在跟随同一进度…" }); } catch {}
    return _bootstrapInFlight;
  }
  _bootstrapInFlight = _bootstrap(opts).finally(() => { _bootstrapInFlight = null; });
  return _bootstrapInFlight;
}

async function _bootstrap({ onProgress, port = 8009, container = "cicy-code-docker", volume = "cicy-team", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };

  // 0) Fast path: already healthy → instant no-op (idempotent one-shot).
  if (await probeHealth(port)) {
    emit({ phase: "done", status: "done", message: "Docker cicy-code 已就绪 🎉" });
    return { ok: true, container };
  }

  // 1) WSL2 platform
  if (docker.wslMissing()) {
    const w = await docker.ensureWsl({ emit });
    if (w.needsReboot) { emit({ phase: "done", status: "reboot", message: "WSL2 正在安装——请【重启 Windows】后回来点「重试」继续。" }); return { ok: false, reason: "wsl_reboot_required" }; }
  }

  // 2) Ubuntu distro
  if (!distroInstalled()) {
    try { await installDistro({ emit }); } catch (e) { emit({ phase: "install-docker", status: "error", message: `Ubuntu 安装失败：${e.message}（点重试）` }); return { ok: false, reason: "distro_install_failed" }; }
    const t0 = Date.now();
    const ok = await docker.waitUntil(() => distroInstalled(), { totalMs: 600000, everyMs: 5000, onTick: () => emit({ phase: "install-docker", status: "running", message: `正在下载/注册 Ubuntu…（已 ${Math.round((Date.now() - t0) / 1000)}s,首次较慢请耐心）` }) });
    if (!ok) { emit({ phase: "install-docker", status: "error", message: "Ubuntu 还没装好——稍等或点「重试」" }); return { ok: false, reason: "distro_not_ready" }; }
  }

  // 3) Docker Engine inside Ubuntu
  if (!(await dockerInstalled())) {
    try { await installDockerEngine({ emit }); } catch (e) { emit({ phase: "install-docker", status: "error", message: `Docker 安装失败：${e.message}（点重试）` }); return { ok: false, reason: "docker_install_failed" }; }
  }

  // 4) dockerd up (phase "container" = 启动服务)
  if (!(await dockerEngineUp())) {
    emit({ phase: "container", status: "running", message: "启动 Docker 引擎（首次较慢，请耐心）…" });
    const started = await startEngine(); // 3 clean attempts internally
    const up = started || await docker.waitUntil(dockerEngineUp, { totalMs: 120000, everyMs: 3000 });
    if (!up) {
      const log = await dockerdLogTail();
      emit({ phase: "container", status: "error", message: "Docker 引擎没起来——点「重试」" + (log ? `\n\ndockerd 日志（最后几行）:\n${log}` : "") });
      return { ok: false, reason: "dockerd_not_up" };
    }
  }

  // 5) Base image — pre-baked into the package, so this normally just confirms.
  //    The download-tarball path is a fallback for a non-pre-baked rootfs.
  if (!(await imagePresent())) {
    let tarball;
    try { tarball = await docker.downloadImageTarball({ emit }); }
    catch (e) { emit({ phase: "image", status: "error", message: `镜像下载失败：${e.message}（点重试续传）` }); return { ok: false, reason: "image_download_failed" }; }
    try { await loadImage(tarball, { emit }); }
    catch (e) { emit({ phase: "image", status: "error", message: `镜像导入失败：${e.message}（点重试）` }); return { ok: false, reason: "image_load_failed" }; }
  }

  // 6) Container (phase "container" = 启动服务)
  if (!(await probeHealth(port))) {
    emit({ phase: "container", status: "running", message: "启动 cicy-code 服务…" });
    try { await runContainer({ port, container, volume, env }); }
    catch (e) { emit({ phase: "container", status: "error", message: `服务启动失败：${e.message}（点重试）` }); return { ok: false, reason: "container_start_failed" }; }
  }

  // 7) Health — the ONLY path to ok:true.
  emit({ phase: "container", status: "running", message: "等待 cicy-code 就绪…" });
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  if (healthy) { await ensureAutostart(); await ensureDesktopShortcut(volume); } // survive reboot + desktop shortcut
  emit({ phase: healthy ? "done" : "container", status: healthy ? "done" : "error", message: healthy ? "Docker cicy-code 已就绪 🎉" : `服务起来了但 :${port} 还没响应——稍等或点「重试」` });
  return { ok: healthy, container };
}

// Lifecycle (card ⋯ menu).
// Restart ONLY cicy-code via supervisor — cron / sshd / user daemons keep
// running (that's the whole point of the supervisor layout). Falls back to a
// full container restart on the pre-supervisor image.
async function restart({ container = "cicy-code-docker", port = 8009, volume = "cicy-team" } = {}) {
  await startEngine();
  try {
    await wslRun(`docker exec ${container} supervisorctl -c /etc/supervisor/supervisord.conf restart cicy-code`, { timeout: 30000 });
  } catch {
    try { await wslRun(`docker restart ${container}`, { timeout: 60000 }); } catch {}
  }
  const ok = await docker.waitUntil(() => probeHealth(port), { totalMs: 60000, everyMs: 2000 });
  if (ok) await ensureDesktopShortcut(volume);
  return ok;
}

// Update cicy-code IN PLACE: the supervisor image ships cicy-code-update.sh,
// which installs the latest version side-by-side, repoints the symlink, and
// `supervisorctl restart cicy-code` — no container recreate, daemons untouched.
// Streamed to the drawer so the user sees the npm pull + restart.
async function update({ onProgress, container = "cicy-code-docker", port = 8009 } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  await startEngine();
  emit({ phase: "image", status: "running", message: "更新 cicy-code（拉取最新版）…" });
  try {
    await wslRunStream(`docker exec ${container} bash -lc "command -v cicy-code-update.sh >/dev/null && cicy-code-update.sh || /usr/local/bin/cicy-code-update.sh"`,
      { emit, phase: "image", timeout: 300000 });
  } catch (e) {
    emit({ phase: "done", status: "error", message: `更新失败：${e.message}（此镜像可能不支持，试试「升级」重装）` });
    return { ok: false, reason: "update_failed" };
  }
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? "cicy-code 已更新到最新 🎉" : "更新了但 :8009 还没响应——稍等或点重试" });
  return { ok: healthy };
}
async function stop({ container = "cicy-code-docker" } = {}) {
  try { await wslRun(`docker stop ${container}`, { timeout: 30000 }); } catch {}
}
// Unregister the dedicated distro (idempotent; no-op if absent). Used by upgrade
// to wipe a stale install before re-importing the latest pre-baked package.
function unregisterDistro() {
  return new Promise((resolve) => {
    execFile("wsl", ["--unregister", DISTRO], { timeout: 120000, windowsHide: true }, () => resolve());
  });
}

// Upgrade = re-import the latest pre-baked 烤制包 (it carries the latest cicy-code
// image). DockerHub `docker pull` is unreliable in CN, and the standalone image
// `docker save` tarball was retired — so re-import (via the app's own resilient
// downloader, which copes with the flaky CN DNS that bare curl can't) is the
// only reliable CN update path. This RESETS the distro: the cicy-team volume is
// re-created and the instance re-seeds (new token) on next boot.
async function upgrade({ onProgress, port = 8009, container = "cicy-code-docker", volume = "cicy-team", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  emit({ phase: "install-docker", status: "running", message: "升级 = 拉取最新运行环境并重装（会重置容器数据）…" });
  try { await stop({ container }); } catch {}
  try { await unregisterDistro(); } catch {}
  // Reuse the robust one-shot install flow (download → import → dockerd → run).
  return await _bootstrap({ onProgress, port, container, volume, env });
}

module.exports = {
  bootstrap, status, restart, stop, update, upgrade, runContainer, readContainerToken,
  distroInstalled, dockerInstalled, dockerEngineUp, imagePresent, probeHealth, wslRun,
};
