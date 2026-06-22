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
const log = require("electron-log"); // persisted main.log — bootstrap timing/failures land here

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
// TRI-STATE: true = distro present, false = wsl answered + distro absent,
// null = wsl DIDN'T answer (timeout/hung). The null case matters: a stuck WSL
// must NOT be reported as "not installed" (that's what made the homepage show
// 「下载安装」even though it was installed). Callers that only need a boolean
// treat null as falsy (unchanged); status() surfaces null as `unknown`.
async function distroInstalled(distro = DISTRO) {
  if (process.platform !== "win32") return false;
  // ASYNC execFile (sync froze the main process on a cold/stuck WSL → "未响应").
  return await new Promise((resolve) => {
    // 25s, NOT 8s: a COLD WSL2 VM takes 10-20s just to boot before it answers the
    // first `wsl -l -q`, so an 8s timeout falsely returns null(unknown) → the
    // homepage gets stuck on 「重试检测」 instead of offering 「安装」. A warm WSL
    // answers in <1s, so the longer ceiling never bites in the normal case.
    execFile("wsl", ["-l", "-q"], { timeout: 25000, windowsHide: true, encoding: "utf16le" }, (err, stdout) => {
      // Our timeout killed it / it was signalled → WSL didn't answer → UNKNOWN.
      if (err && (err.killed || err.signal || err.code === "ETIMEDOUT")) return resolve(null);
      // Other errors (wsl missing / non-zero exit) → definitively not our distro.
      if (err) return resolve(false);
      resolve(String(stdout || "").split(/\r?\n/).map((s) => s.replace(/\0/g, "").trim()).filter(Boolean)
        .some((d) => d.toLowerCase() === distro.toLowerCase()));
    });
  });
}

// Install the Ubuntu distro WITHOUT launching its interactive first-run setup
// (--no-launch). We always run commands as root afterwards, so no user account
// is needed. Elevated via the scheduled-task path (reliable on these machines).
// Raw `wsl --import` of the rootfs as an ISOLATED v2 distro.
function importTarball(dest, installDir) {
  return new Promise((resolve, reject) => {
    // 240s, NOT 600s: a 444MB import finishes in well under 4min on a healthy WSL.
    // If it runs longer it has WEDGED (the whole WSL subsystem hangs — every later
    // `wsl` call then blocks and the app goes 未响应). Bound it short so we FAIL FAST
    // and the caller can `wsl --shutdown` + retry instead of hanging 10 minutes.
    execFile("wsl", ["--import", DISTRO, installDir, dest, "--version", "2"],
      { timeout: 240000, windowsHide: true },
      (err, _so, se) => { if (err) { err.stderr = String(se || ""); return reject(err); } resolve(); });
  });
}

// `wsl --shutdown`: hard-reset the ENTIRE WSL VM. This is the only reliable cure
// when WSL wedges (a hung `wsl --import` leaves every subsequent `wsl` call
// blocking → the app freezes). Unlike `wsl --list/-d` it doesn't query the wedged
// VM, so it returns even when WSL is stuck. Use it as recovery between retries.
function wslShutdown() {
  return new Promise((resolve) => {
    execFile("wsl", ["--shutdown"], { timeout: 30000, windowsHide: true }, () => resolve());
  });
}

// `wsl --terminate <distro>`: stop the distro so the NEXT `wsl -d` cold-boots it
// clean. This is the fix for the「引擎没起来」-on-fresh-install failure: a distro
// straight out of `wsl --import` is frequently half-initialized / unresponsive,
// so startEngine's first `wsl -d` command times out, dockerd never launches, and
// its log is never even created (exactly what we saw on a new Windows user). A
// terminate + cold boot makes that first real command hit a clean distro.
function wslTerminate() {
  return new Promise((resolve) => {
    execFile("wsl", ["--terminate", DISTRO], { timeout: 30000, windowsHide: true }, () => resolve());
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
    // Import failed or WEDGED (our 4-min timeout fired). Recover hard, then retry once:
    //   1) `wsl --shutdown` — clears a wedged WSL VM (the real cause of the 8-min hang
    //      + app freeze). Without this the retry hits the same stuck VM and hangs again.
    //   2) ensure the WSL2 kernel (import also fails when it's missing).
    //   3) unregister any half-registered distro a wedged import left behind, so the
    //      retry imports clean.
    log.warn(`[installDistro] import failed/wedged (${e.message}) → wsl --shutdown + retry`);
    emit && emit({ phase: "container", status: "running", message: "导入卡住,重置 WSL(--shutdown)后重试…" });
    try { await wslShutdown(); } catch {}
    try { await ensureWslKernel({ emit }); } catch {}
    try { await new Promise((r) => execFile("wsl", ["--unregister", DISTRO], { timeout: 30000, windowsHide: true }, () => r())); } catch {}
    await importTarball(dest, installDir);
  }
  // 3) Force a clean cold boot. A freshly-imported distro is often wedged, so the
  //    next `wsl -d` (startEngine) would time out → dockerd never starts. Terminate
  //    now so that first real command boots a clean distro instead.
  emit && emit({ phase: "container", status: "running", message: "重置运行环境(冷启动)…" });
  try { await wslTerminate(); } catch {}

  // 4) KEEP the rootfs (deletion removed per 主人). Deleting it forced a fresh
  //    447MB re-download on every reinstall / new user / clean retry — the main
  //    「怎么这么慢」 pain. We keep it so reinstall reuses it (curlDownload skips a
  //    complete file). Users who want the disk back can delete the tarball manually.
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
// Launch dockerd FULLY DETACHED. This is the core fix for the all-day「WSL 卡死 /
// app 未响应」: the old launch `(nohup dockerd >log 2>&1 &)` left dockerd in the wsl
// session with stdin still on the wsl pipe, so `wsl.exe` would NOT exit — the
// launching call hung (up to its 150s timeout), and a hung wsl session wedges the
// whole WSL subsystem so every later `wsl` call blocks and the app freezes.
//   setsid → new session (detached from the wsl console)
//   </dev/null + >log 2>&1 → no shared stdio with the wsl pipe
// ⇒ the launch returns INSTANTLY and dockerd is fully orphaned. Short timeout: if
// THIS times out, WSL itself is already wedged (not dockerd's fault).
// The boot/autostart script the rootfs ships (run by wsl.conf [boot] + our logon
// task) used a NON-detached `nohup dockerd &`, which hangs the logon wsl.exe and
// wedges WSL on every reboot. Rewrite it to launch detached too. base64 so the
// multi-line script survives `bash -lc "…"` without any quote escaping.
const BOOT_SCRIPT_B64 = Buffer.from(
  "#!/bin/sh\n" +
  "update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || true\n" +
  "update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || true\n" +
  "pgrep dockerd >/dev/null 2>&1 || setsid sh -c 'exec dockerd >/var/log/dockerd.log 2>&1 </dev/null' &\n"
).toString("base64");

async function launchDockerd() {
  await wslRun(
    `echo ${BOOT_SCRIPT_B64} | base64 -d > /usr/local/sbin/start-dockerd.sh 2>/dev/null; chmod +x /usr/local/sbin/start-dockerd.sh 2>/dev/null; ` +
    "update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1; " +
    "update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1; " +
    // Stale /var/run/docker.{pid,sock} from the pre-baked rootfs make a fresh dockerd
    // refuse to start; clear them when dockerd isn't already running.
    "if ! pgrep dockerd >/dev/null 2>&1; then rm -f /var/run/docker.pid /run/docker.pid /var/run/docker.sock /run/docker.sock; fi; " +
    "pgrep dockerd >/dev/null 2>&1 || setsid bash -c 'exec dockerd >/var/log/cicy-dockerd.log 2>&1 </dev/null' & " +
    "true",
    { timeout: 20000 });
}

async function startEngine() {
  // Up to 3 attempts. Each: launch dockerd (detached, returns instantly) then POLL
  // the socket in SHORT, SEPARATE wsl calls — never hold the distro in one 120s call
  // (that both masked wedges and blocked everything else). Cold first boot of a
  // freshly-imported distro can take well over 40s, so poll up to 90s.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const at0 = Date.now();
    let stuck = false;
    log.info(`[startEngine] attempt ${attempt}/3 — launch dockerd (detached) + poll socket`);
    try { await launchDockerd(); }
    catch (e) { stuck = true; log.warn(`[startEngine] attempt ${attempt} launch errored — WSL stuck? ${e.message}`); }
    if (!stuck) {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        if (await dockerEngineUp()) { log.info(`[startEngine] ✓ dockerd up on attempt ${attempt} (${((Date.now() - at0) / 1000).toFixed(1)}s)`); return true; }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    log.warn(`[startEngine] attempt ${attempt} dockerd not up after ${((Date.now() - at0) / 1000).toFixed(1)}s`);
    // Recover. A stuck launch = WSL wedged → `wsl --shutdown` (full VM reset — the
    // ONLY thing that clears a real wedge; --terminate isn't enough). Otherwise
    // dockerd just died/is slow → clear stale runtime files for a clean relaunch.
    if (stuck) { log.info(`[startEngine] WSL stuck → wsl --shutdown`); try { await wslShutdown(); } catch {} }
    else { try { await wslRun("if ! pgrep dockerd >/dev/null 2>&1; then rm -f /var/run/docker.pid /run/docker.pid /var/run/docker.sock /run/docker.sock; fi", { timeout: 15000 }); } catch {} }
  }
  log.error("[startEngine] ✗ dockerd NOT up after 3 attempts");
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
// Shared folder bind: the CURRENT Windows user's ~/Desktop/Share ↔
// /home/cicy/cicy-ai/Share in the container — a drop-zone both the user and the
// agent can read/write. Auto-created (with a readme) on every container start if
// missing; os.homedir() makes it per-user (never hard-coded to one account).
// Returns the docker `-v` arg, or "" if setup fails (mount is best-effort).
const SHARE_README = `# CiCy 共享目录 / Shared Folder

这个文件夹与 CiCy 容器之间双向共享 —— 你和容器里的 agent 都能读写同一份文件。

- 你的电脑上: ~/Desktop/Share （就是这个文件夹）
- 容器里: /home/cicy/cicy-ai/Share

把文件丢进来,CiCy 里的 agent 就能访问;agent 写到容器 Share 里的东西,也会出现在这里。

---

This folder is shared both ways between your computer and the CiCy container.

- On your computer: ~/Desktop/Share (this folder)
- Inside the container: /home/cicy/cicy-ai/Share

Drop files here for CiCy agents to read; files agents write to Share show up here too.
`;

function shareMountArg() {
  try {
    const winShare = path.join(os.homedir(), "Desktop", "Share");
    fs.mkdirSync(winShare, { recursive: true });
    const readme = path.join(winShare, "readme.md");
    if (!fs.existsSync(readme)) { try { fs.writeFileSync(readme, SHARE_README); } catch {} }
    // C:\Users\<user>\Desktop\Share → /mnt/c/Users/<user>/Desktop/Share (WSL view)
    const wslShare = winShare.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");
    return `-v '${wslShare}':/home/cicy/cicy-ai/Share`;
  } catch (e) { log.warn(`[wsl-docker] Share mount setup failed: ${e.message}`); return ""; }
}

async function runContainer({ port = 8009, container = "cicy-code-docker", volume = "cicy-team-8009", env = {} } = {}) {
  // 每次容器"启动"(含已在跑被 adopt)都确保桌面快捷方式存在 —— 不存在就建,坏了就修。
  if (await probeHealth(port)) { ensureDesktopShortcut(volume, port).catch(() => {}); return { adopted: true }; }
  // Replace any stale same-named container.
  try { await wslRun(`docker rm -f ${container}`, { timeout: 20000 }); } catch {}
  const envArgs = Object.entries(env || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `-e ${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  // --dns: WSL2's auto resolv.conf points the distro at the host NAT gateway
  // (172.x.x.1), which docker's default DNS forwarding does NOT reach from inside a
  // bridge container → every lookup is EAI_AGAIN and cicy-code's startup `npm i`
  // crash-loops the container (:8009 never comes up). Pin public resolvers: Aliyun
  // 223.5.5.5 (CN-fast) first, Google 8.8.8.8 as the overseas fallback.
  const cmd = `docker run -d --name ${container} --restart unless-stopped --dns 223.5.5.5 --dns 8.8.8.8 -p 127.0.0.1:${port}:8008 -e CICY_PUBLIC=1 -v ${volume}:/home/cicy ${shareMountArg()} ${envArgs} ${IMAGE}`;
  await wslRun(cmd, { timeout: 60000 });
  ensureDesktopShortcut(volume, port).catch(() => {});
  return { started: true };
}

// Read the container's OWN api_token (its volume-persisted global.json). This is
// the ONLY correct credential for :8009 — the host's 8008 token is different and
// 8009 rejects it. Retries because right after start the entrypoint may not have
// written global.json yet; returns "" only if it truly can't be read (callers
// must then NOT open with a wrong/host token — that strands the user at login).
async function readContainerToken(port = 8009, container = "cicy-code-docker", volume = "cicy-team-8009") {
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
      { windowsHide: true }, (err, _stdout, stderr) => {
        if (err) log.warn(`[ensureAutostart] schtasks create FAILED (dockerd won't auto-start after reboot): ${err.message}${stderr ? ` / ${String(stderr).trim()}` : ""}`);
        else log.info("[ensureAutostart] logon task 'cicy-docker-autostart' registered → dockerd starts on next logon");
        res();
      });
  });
}

// Drop a desktop shortcut (folder icon) to the container's /home/cicy — i.e. the
// cicy-team volume on the distro — so the user can browse :8009's files from
// Windows Explorer. \\wsl$\<distro>\… is the UNC view of the WSL filesystem.
// Idempotent: CreateShortcut overwrites. Best-effort (errors swallowed).
// PowerShell single-quoted literal. PowerShell does NOT treat backslash as an
// escape (it uses backtick), so backslashes are literal — only ' needs doubling.
// The previous code used JSON.stringify here, whose \\ escaping was stored
// VERBATIM by PowerShell → the shortcut target became \\\\wsl$\\…\\_data (doubled
// backslashes) which Explorer can't open. That was the broken "WSL 快捷方式".
function psSingle(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function ensureDesktopShortcut(volume = "cicy-team-8009", port = 8009) {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((res) => {
    // 快捷方式名带 port —— 多个 docker(不同端口)各自一个桌面文件夹快捷方式。
    // 纯 ASCII 文件名:中文文件名在不同编码下会变乱码,直接避开。
    const lnk = path.join(os.homedir(), "Desktop", `cicy-${port}.lnk`);
    // JS string: \\\\ → \\ and \\ → \, so target = \\wsl$\<distro>\…\_data (a
    // correct UNC path with exactly two leading backslashes).
    const target = `\\\\wsl$\\${DISTRO}\\var\\lib\\docker\\volumes\\${volume}\\_data`;
    // 每次都重建(覆盖)= 自愈:不存在→创建,存在但坏了/指向旧 volume→修正。
    const ps =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$w=New-Object -ComObject WScript.Shell;` +
      `$s=$w.CreateShortcut(${psSingle(lnk)});` +
      `$s.TargetPath='explorer.exe';` +
      `$s.Arguments=${psSingle(target)};` +
      `$s.IconLocation='imageres.dll,3';` +         // yellow Windows folder icon
      `$s.Description=${psSingle(`cicy-code :${port} /home/cicy`)};` +
      `$s.Save()`;
    execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 15000 }, () => res());
  });
}

// Composite status for the card.
async function status(port = 8009) {
  // `unknown` = WSL didn't answer a probe (stuck/booting). The homepage uses it
  // to show 「检测中/WSL 无响应·重试」instead of falsely showing 「下载安装」.
  const miss = await docker.wslMissing();           // true | false | null(unknown)
  if (miss === null) return { wsl: false, distro: false, engineUp: false, running: false, unknown: true };
  const wsl = !miss;
  let distro = false, unknown = false;
  if (wsl) {
    const di = await distroInstalled();             // true | false | null(unknown)
    if (di === null) unknown = true; else distro = !!di;
  }
  const engineUp = !!(distro && (await dockerEngineUp()));
  const running = !!(engineUp && (await probeHealth(port)));
  return { wsl, distro, engineUp, running, unknown };
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

  // Structured, PERSISTED trace of the whole run (electron-log → main.log) so a
  // failed "重启后起不来" is diagnosable AFTER the fact instead of staring at the
  // ephemeral progress modal. Each step logs ▶start / ✓done(+duration, or "skip"
  // when already satisfied) / ✗fail(+reason+duration); the final line gives the
  // total time and the SLOWEST step, plus a [name,ms] breakdown of every step.
  const BT0 = Date.now();
  const secs = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
  const steps = [];
  let _pt = BT0, _pname = "";
  const begin = (name) => { _pname = name; _pt = Date.now(); log.info(`[bootstrap] ▶ ${name}`); };
  const done  = (skip) => { steps.push([_pname, Date.now() - _pt]); log.info(`[bootstrap] ✓ ${_pname}${skip ? " (skip)" : ""} ${secs(_pt)}`); };
  const fail  = (reason, extra) => { steps.push([`${_pname}:FAIL`, Date.now() - _pt]); log.error(`[bootstrap] ✗ ${_pname} reason=${reason} ${secs(_pt)}${extra ? `\n${extra}` : ""}`); };
  const finish = (ok, reason) => {
    const slow = steps.slice().sort((a, b) => b[1] - a[1])[0];
    log.info(`[bootstrap] ${ok ? "DONE ✓" : `ABORT ✗ reason=${reason}`} total=${secs(BT0)} slowest=${slow ? `${slow[0]} ${(slow[1] / 1000).toFixed(1)}s` : "n/a"} steps=${JSON.stringify(steps.map(([n, d]) => [n, Math.round(d)]))}`);
  };
  log.info(`[bootstrap] START port=${port} container=${container} volume=${volume}`);

  // 0) Fast path: already healthy → instant no-op (idempotent one-shot).
  begin("probe-healthy");
  if (await probeHealth(port)) {
    done();
    emit({ phase: "done", status: "done", message: "Docker cicy-code 已就绪 🎉" });
    finish(true);
    return { ok: true, container };
  }
  done();

  // 1) WSL2 platform
  begin("ensure-wsl");
  if (await docker.wslMissing()) {
    const w = await docker.ensureWsl({ emit });
    if (w.needsReboot) { fail("wsl_reboot_required"); emit({ phase: "done", status: "reboot", message: "WSL2 正在安装——请【重启 Windows】后回来点「重试」继续。" }); finish(false, "wsl_reboot_required"); return { ok: false, reason: "wsl_reboot_required" }; }
    done();
  } else done(true);

  // 2) Ubuntu distro
  begin("ensure-distro");
  if (!(await distroInstalled())) {
    try { await installDistro({ emit }); } catch (e) { fail("distro_install_failed", e.message); emit({ phase: "install-docker", status: "error", message: `Ubuntu 安装失败：${e.message}（点重试）` }); finish(false, "distro_install_failed"); return { ok: false, reason: "distro_install_failed" }; }
    const t0 = Date.now();
    const ok = await docker.waitUntil(() => distroInstalled(), { totalMs: 600000, everyMs: 5000, onTick: () => emit({ phase: "install-docker", status: "running", message: `正在下载/注册 Ubuntu…（已 ${Math.round((Date.now() - t0) / 1000)}s,首次较慢请耐心）` }) });
    if (!ok) { fail("distro_not_ready"); emit({ phase: "install-docker", status: "error", message: "Ubuntu 还没装好——稍等或点「重试」" }); finish(false, "distro_not_ready"); return { ok: false, reason: "distro_not_ready" }; }
    done();
  } else done(true);

  // 3) Docker Engine inside Ubuntu
  begin("install-docker-engine");
  if (!(await dockerInstalled())) {
    try { await installDockerEngine({ emit }); } catch (e) { fail("docker_install_failed", e.message); emit({ phase: "install-docker", status: "error", message: `Docker 安装失败：${e.message}（点重试）` }); finish(false, "docker_install_failed"); return { ok: false, reason: "docker_install_failed" }; }
    done();
  } else done(true);

  // 4) dockerd up (phase "container" = 启动服务)
  begin("start-dockerd");
  if (!(await dockerEngineUp())) {
    emit({ phase: "container", status: "running", message: "启动 Docker 引擎（首次较慢，请耐心）…" });
    const started = await startEngine(); // 3 clean attempts internally
    const up = started || await docker.waitUntil(dockerEngineUp, { totalMs: 120000, everyMs: 3000 });
    if (!up) {
      const dlog = await dockerdLogTail();
      fail("dockerd_not_up", dlog ? `dockerd log:\n${dlog}` : "");
      emit({ phase: "container", status: "error", message: "Docker 引擎没起来——点「重试」" + (dlog ? `\n\ndockerd 日志（最后几行）:\n${dlog}` : "") });
      finish(false, "dockerd_not_up");
      return { ok: false, reason: "dockerd_not_up" };
    }
    done();
  } else done(true);

  // 5) Base image — pre-baked into the package, so this normally just confirms.
  //    The download-tarball path is a fallback for a non-pre-baked rootfs.
  begin("ensure-image");
  if (!(await imagePresent())) {
    let tarball;
    try { tarball = await docker.downloadImageTarball({ emit }); }
    catch (e) { fail("image_download_failed", e.message); emit({ phase: "image", status: "error", message: `镜像下载失败：${e.message}（点重试续传）` }); finish(false, "image_download_failed"); return { ok: false, reason: "image_download_failed" }; }
    try { await loadImage(tarball, { emit }); }
    catch (e) { fail("image_load_failed", e.message); emit({ phase: "image", status: "error", message: `镜像导入失败：${e.message}（点重试）` }); finish(false, "image_load_failed"); return { ok: false, reason: "image_load_failed" }; }
    done();
  } else done(true);

  // 6) Container (phase "container" = 启动服务)
  begin("run-container");
  if (!(await probeHealth(port))) {
    emit({ phase: "container", status: "running", message: "启动 cicy-code 服务…" });
    try { await runContainer({ port, container, volume, env }); }
    catch (e) { fail("container_start_failed", e.message); emit({ phase: "container", status: "error", message: `服务启动失败：${e.message}（点重试）` }); finish(false, "container_start_failed"); return { ok: false, reason: "container_start_failed" }; }
    done();
  } else done(true);

  // 7) Health — the ONLY path to ok:true.
  begin("wait-health");
  emit({ phase: "container", status: "running", message: "等待 cicy-code 就绪…" });
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  if (healthy) { done(); await ensureAutostart(); await ensureDesktopShortcut(volume, port); } // survive reboot + desktop shortcut
  else fail("health_timeout");
  emit({ phase: healthy ? "done" : "container", status: healthy ? "done" : "error", message: healthy ? "Docker cicy-code 已就绪 🎉" : `服务起来了但 :${port} 还没响应——稍等或点「重试」` });
  finish(healthy, healthy ? null : "health_timeout");
  return { ok: healthy, container };
}

// Lifecycle (card ⋯ menu).
// Restart ONLY cicy-code via supervisor — cron / sshd / user daemons keep
// running (that's the whole point of the supervisor layout). Falls back to a
// full container restart on the pre-supervisor image.
async function restart({ container = "cicy-code-docker", port = 8009, volume = "cicy-team-8009" } = {}) {
  await startEngine();
  try {
    await wslRun(`docker exec ${container} supervisorctl -c /etc/supervisor/supervisord.conf restart cicy-code`, { timeout: 30000 });
  } catch {
    try { await wslRun(`docker restart ${container}`, { timeout: 60000 }); } catch {}
  }
  const ok = await docker.waitUntil(() => probeHealth(port), { totalMs: 60000, everyMs: 2000 });
  if (ok) await ensureDesktopShortcut(volume, port);
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

// docker restart 整个容器(stop+start 同一个容器)—— 区别于 restart()(supervisorctl
// 重启容器内的 cicy-code 进程)和重建(rm+run)。容器重启后 entrypoint 重跑,会重读
// volume global.json,所以若先把新 key 写进 volume,这个就能让 cicy-code 用上新 key。
async function dockerRestart({ container = "cicy-code-docker-8009" } = {}) {
  await wslRun(`docker restart ${container}`, { timeout: 45000 });
  return true;
}

// 重建容器:docker rm -f 旧容器 + docker run 新容器(用新 env,如新的 docker team 网关
// key)。**保留 volume**(数据/api_token/deviceId 不丢),只是换掉容器本身 + env。
// 破坏性(短暂中断 + 换 key)→ 调用方要 confirm。
async function recreate({ port = 8009, container = "cicy-code-docker-8009", volume = "cicy-team-8009", env = {} } = {}) {
  // 强删占用该端口的**任何**容器(含老名字 cicy-code-docker)+ 目标容器 —— 否则
  // runContainer 开头的 probeHealth 看到旧容器还健康会 adopt 它、不重建,key 就换不了。
  try { await wslRun(`docker ps -aq --filter publish=${port} | xargs -r docker rm -f 2>/dev/null; docker rm -f ${container} 2>/dev/null; true`, { timeout: 30000 }); } catch {}
  const r = await runContainer({ port, container, volume, env });
  try { await ensureDesktopShortcut(volume, port); } catch {}
  return r;
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
  bootstrap, status, restart, stop, dockerRestart, recreate, update, upgrade, runContainer, readContainerToken,
  distroInstalled, dockerInstalled, dockerEngineUp, imagePresent, probeHealth, wslRun,
};
