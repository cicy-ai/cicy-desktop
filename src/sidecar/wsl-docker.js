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
const { t } = require("../i18n"); // 打开/读 token 的可见日志走 i18n

// Dedicated distro name — NEVER reuse/clobber a user's own "Ubuntu" distro.
const DISTRO   = process.env.CICY_WSL_DISTRO || "cicy-code-wsl";
const IMAGE    = process.env.CICY_DOCKER_IMAGE || "cicybot/cicy-code:latest";
// 主人: 容器额外暴露的端口段(给容器内 agent 跑服务用),宿主 127.0.0.1 直达。
const EXTRA_PORTS = process.env.CICY_EXTRA_PORTS || "18000-19999";
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
    // 主人标准: 每步先把「执行的命令是什么」打到 drawer(和 mac 的 `$ brew install …` 一致)。
    if (emit) emit({ phase, status: "running", message: `$ ${cmd.length > 200 ? cmd.slice(0, 200) + " …" : cmd}` });
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

// 把失败的真 stderr/stdout 尾巴拼出来(主人标准: "报错是什么" —— 不能只显示 "exit 100")。
// wslRun reject 时把 err.stdout/err.stderr 挂上;这里取最后 ~600 字符贴进 drawer。
function errTail(e) {
  const s = String((e && (e.stderr || e.stdout)) || "").trim();
  return s ? `\n\n${s.slice(-600)}` : "";
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

// Kill whatever Windows process is LISTENING on 127.0.0.1:<port>. The orphaned-distro
// failure mode: the distro gets unregistered (wsl --list empty) but a ZOMBIE
// wslhost.exe keeps holding the :8009 port-forward — so health probes still 200
// even after `wsl --shutdown`, masking that the backend is gone and the port is
// occupied (a fresh re-import's container can't bind :8009). Get-NetTCPConnection →
// Stop-Process the owner. Best-effort; resolves regardless.
function killPortListener(port) {
  return new Promise((resolve) => {
    const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`;
    execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 15000 }, () => resolve());
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
  // REUSE a complete rootfs already on disk (pre-staged into ~/Downloads, or left by
  // a prior run) BEFORE curlDownload touches it. The bug: curlDownload doesn't skip a
  // complete file (and on a failed curl it truncated the staged 447MB), so a staged
  // rootfs got re-downloaded. headSize uses node http (works even when curl can't
  // resolve the host — the `curl exit 6` we saw), so this skip is reliable.
  let haveComplete = false;
  try {
    const expected = await docker.headSize(ROOTFS_URL);
    const have = fs.statSync(dest).size;
    haveComplete = expected > 0 && have === expected;
    if (haveComplete) emit && emit({ phase: "image", status: "skip", message: "下载运行环境:已有完整包,跳过下载", progress: 100, received: have, total: expected });
  } catch {}
  if (!haveComplete) {
    try { await docker.curlDownload(ROOTFS_URL, dest, { emit, phase: "image", label: "下载运行环境" }); }
    catch (e) {
      emit && emit({ phase: "image", status: "running", message: `下载器异常(${e.message}),改用备用下载…` });
      await docker.ensureDownloaded(ROOTFS_URL, dest, null, { emit, phase: "image", label: "下载运行环境" });
    }
  }
  // 2) Import as an ISOLATED WSL2 distro: its OWN VHDX under a dedicated dir, so
  //    it never touches the user's existing distros. `--version 2` sets just THIS
  //    distro to v2 — we do NOT run `--set-default-version` (that would change the
  //    user's global default). The WSL2 kernel is shared; we install it ONLY when
  //    import actually fails for lack of it (never downgrade an existing kernel).
  const installDir = path.join(process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local"), "cicy-code-wsl");
  try { fs.mkdirSync(installDir, { recursive: true }); } catch {}
  emit && emit({ phase: "container", status: "running", message: `$ wsl --import ${DISTRO} "${installDir}" "${dest}" --version 2（约 444MB,1-4 分钟,无实时进度,请耐心)` });
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

// Hold the distro OPEN. The flip side of detaching dockerd: once the launching
// wsl.exe exits, WSL tears the distro down if no session holds it — killing the
// just-launched dockerd (the "启动引擎 转圈但 dockerd=none" we saw). A detached,
// long-lived `wsl … sleep infinity` keeps the distro alive so dockerd (and the
// container) survive. unref'd so it never blocks the app; survives app exit too.
let _keepalive = null;
function ensureKeepalive() {
  if (process.platform !== "win32") return;
  if (_keepalive && _keepalive.exitCode == null && !_keepalive.killed) return;
  try {
    _keepalive = spawn("wsl", ["-d", DISTRO, "-u", "root", "--", "sh", "-c", "exec sleep infinity"],
      { detached: true, stdio: "ignore", windowsHide: true });
    _keepalive.on("error", (e) => { log.warn(`[keepalive] ${e.message}`); _keepalive = null; });
    _keepalive.on("exit", () => { _keepalive = null; });
    _keepalive.unref();
    log.info("[keepalive] holding distro open (sleep infinity)");
  } catch (e) { log.warn(`[keepalive] spawn failed: ${e.message}`); }
}

async function launchDockerd() {
  await wslRun(
    `echo ${BOOT_SCRIPT_B64} | base64 -d > /usr/local/sbin/start-dockerd.sh 2>/dev/null; chmod +x /usr/local/sbin/start-dockerd.sh 2>/dev/null; ` +
    "update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1; " +
    "update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1; " +
    // Stale /var/run/docker.{pid,sock} from the pre-baked rootfs make a fresh dockerd
    // refuse to start; clear them when dockerd isn't already running.
    "if ! pgrep dockerd >/dev/null 2>&1; then rm -f /var/run/docker.pid /run/docker.pid /var/run/docker.sock /run/docker.sock; fi; " +
    // setsid --fork: fork dockerd into a NEW session and have setsid EXIT immediately,
    // so this wsl call returns at once and dockerd is fully orphaned (no `& true`
    // backgrounding race). It only survives because ensureKeepalive() holds the distro.
    "pgrep dockerd >/dev/null 2>&1 || setsid --fork bash -c 'exec dockerd >/var/log/cicy-dockerd.log 2>&1 </dev/null'",
    { timeout: 20000 });
}

async function startEngine({ emit } = {}) {
  const e = (ev) => { try { emit && emit(ev); } catch {} };
  // Up to 3 attempts. Each: launch dockerd (detached, returns instantly) then POLL
  // the socket in SHORT, SEPARATE wsl calls — never hold the distro in one 120s call
  // (that both masked wedges and blocked everything else). Cold first boot of a
  // freshly-imported distro can take well over 40s, so poll up to 90s.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const at0 = Date.now();
    let stuck = false;
    log.info(`[startEngine] attempt ${attempt}/3 — keepalive + launch dockerd (detached) + poll socket`);
    e({ phase: "container", status: "running", message: `$ setsid --fork dockerd（第 ${attempt}/3 次,detached）` });
    ensureKeepalive(); // hold the distro open BEFORE launching, or the teardown kills dockerd
    try { await launchDockerd(); }
    catch (err) { stuck = true; log.warn(`[startEngine] attempt ${attempt} launch errored — WSL stuck? ${err.message}`); e({ phase: "container", status: "running", message: `dockerd 启动命令卡住(WSL 可能 wedged):${err.message}` }); }
    if (!stuck) {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        if (await dockerEngineUp()) { log.info(`[startEngine] ✓ dockerd up on attempt ${attempt} (${((Date.now() - at0) / 1000).toFixed(1)}s)`); e({ phase: "container", status: "running", message: `✓ dockerd 已就绪(${((Date.now() - at0) / 1000).toFixed(0)}s)` }); return true; }
        if ((Date.now() - at0) % 10000 < 2100) e({ phase: "container", status: "running", message: `等待 dockerd socket…(已 ${((Date.now() - at0) / 1000).toFixed(0)}s)` });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    log.warn(`[startEngine] attempt ${attempt} dockerd not up after ${((Date.now() - at0) / 1000).toFixed(1)}s`);
    e({ phase: "container", status: "running", message: `第 ${attempt} 次 dockerd 未起,${stuck ? "wsl --shutdown 重置后" : "清理残留 socket 后"}重试…` });
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

// 主人修复「卡在旧镜像」: imagePresent() 只看本地有没有 `:latest`,旧镜像在就永远跳过下载。
// 改成校验 OSS tarball ETag:缺镜像、或 ETag 跟上次 load 不一致 → 重下重载(删旧缓存包)。
// 非破坏性:不删发行版/不删 volume。返回是否真刷新了。与 colima 端逻辑一致。
async function ensureFreshImage({ emit } = {}) {
  const e = (ev) => { try { emit && emit(ev); } catch {} };
  const present = await imagePresent();
  const remote = await docker.remoteImageEtag().catch(() => "");
  const loaded = docker.readLoadedImageEtag();
  if (present && remote && loaded && remote === loaded) return false;
  if (present && !remote) return false; // 拿不到远端指纹,保守不刷
  if (present && remote !== loaded) { e({ phase: "image", status: "running", message: "检测到更新的镜像,正在拉取最新版…" }); docker.clearImageTarball(); }
  let tarball;
  try { tarball = await docker.downloadImageTarball({ emit }); }
  catch (err) { if (present) { e({ phase: "image", status: "running", message: `最新镜像下载失败(${err.message}),沿用现有镜像` }); return false; } throw err; }
  await loadImage(tarball, { emit });
  if (remote) docker.writeLoadedImageEtag(remote);
  return true;
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
// Persistent workspace bind: the CURRENT Windows user's ~/projects ↔
// /home/cicy/projects in the container — both the user and the agent read/write
// it, and it lives on the host disk so it survives container delete/rebuild.
// Auto-created (with a README) on every container start if missing; os.homedir()
// makes it per-user (never hard-coded). Returns the `-v` arg, or "" on failure.
const PROJECTS_README = `# CiCy 持久工作区 / Persistent Workspace

这个文件夹与 CiCy 容器双向共享,而且是**持久的** —— 它在你电脑的真实磁盘上,
不在容器里。容器删了、重建了、升级了,这里的文件都还在,不会丢。

- 你的电脑上: ~/projects （就是这个文件夹）
- 容器里: /home/cicy/projects

把代码仓库 / 项目放在这里,CiCy 里的 agent 就能直接读写;它们改的东西也实时
出现在你电脑上。容器是临时的,这个目录才是你工作的家。

---

This folder is shared both ways with the CiCy container and is **persistent** —
it lives on your computer's real disk, not inside the container. Delete, rebuild
or upgrade the container and everything here survives.

- On your computer: ~/projects (this folder)
- Inside the container: /home/cicy/projects

Put your repos / projects here; CiCy agents read and write them directly, and
their changes show up live on your machine. The container is disposable — this
directory is where your work actually lives.
`;

// 主人: 把宿主 ~/projects 挂进容器 /home/cicy/projects(~ 用 os.homedir() 展开,绝不写死)。
// Windows 路径 C:\Users\<user>\projects → WSL 视图 /mnt/c/Users/<user>/projects。
function projectsMountArg() {
  try {
    const winProjects = path.join(os.homedir(), "projects");
    fs.mkdirSync(winProjects, { recursive: true });
    const readme = path.join(winProjects, "README.md");
    if (!fs.existsSync(readme)) { try { fs.writeFileSync(readme, PROJECTS_README); } catch {} }
    const wslProjects = winProjects.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");
    return `-v '${wslProjects}':/home/cicy/projects`;
  } catch (e) { log.warn(`[wsl-docker] projects mount setup failed: ${e.message}`); return ""; }
}

async function runContainer({ port = 8009, container = "cicy-code-docker", volume = "cicy-team-8009", env = {}, emit } = {}) {
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
  // 主人方案: Chrome 的 per-profile 代理改由「宿主 mihomo」(host-mihomo.js)服务,不再从容器
  // publish 20001-32(WSL/colima 转发那段口到不了容器里只绑 127.0.0.1 的监听)。容器只暴露 :8009。
  // 只发布 :8009(单端口,1 个 docker-proxy)。EXTRA_PORTS 那段 18000-19999(2000 个端口)
  // 已删——docker 默认每端口起一个 userland-proxy 进程 → 2000 进程,docker run 卡死/吃内存/
  // 偶发失败(主人实测)。容器内 agent 服务需要从 Windows 直达时再按需单独暴露。
  const cmd = `docker run -d --name ${container} --restart unless-stopped --dns 223.5.5.5 --dns 8.8.8.8 -p 127.0.0.1:${port}:8008 -e CICY_PUBLIC=1 -v ${volume}:/home/cicy ${projectsMountArg()} ${envArgs} ${IMAGE}`;
  emit && emit({ phase: "container", status: "running", message: `$ ${cmd.length > 220 ? cmd.slice(0, 220) + " …" : cmd}` });
  await wslRun(cmd, { timeout: 60000 }); // 失败时 err.stderr 带 docker 真错误 → _bootstrap 的 errTail 显示
  ensureDesktopShortcut(volume, port).catch(() => {});
  return { started: true };
}

// Read the container's OWN api_token (its volume-persisted global.json). This is
// the ONLY correct credential for :8009 — the host's 8008 token is different and
// 8009 rejects it. Retries because right after start the entrypoint may not have
// written global.json yet; returns "" only if it truly can't be read (callers
// must then NOT open with a wrong/host token — that strands the user at login).
// 主人原则:执行什么命令、输出什么、报什么错,全都要可见(onLog),且每一步可重试。
// onLog({ status, message }) —— 上层把它接进 drawer。不传也安全(默认静默 + 写 log 文件)。
async function readContainerToken(port = 8009, container = "cicy-code-docker", volume = "cicy-team-8009", { onLog } = {}) {
  const say = (status, message) => {
    try { (status === "error" ? log.warn : log.info)(`[readContainerToken] ${message}`); } catch (e) {}
    try { onLog && onLog({ status, message }); } catch (e) {}
  };
  const volCmd = `cat /var/lib/docker/volumes/${volume}/_data/cicy-ai/global.json`;
  const execCmd = `docker exec ${container} cat /home/cicy/cicy-ai/global.json`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    // 1) Fast + reliable: read the volume-backed global.json straight from the
    //    distro fs. `docker exec` into a just-loaded/busy container is slow and
    //    frequently times out. The bind volume read never does that.
    say("running", `$ wsl -d ${DISTRO} -- ${volCmd}`);
    try {
      const { stdout } = await wslRun(`${volCmd} 2>/dev/null`, { timeout: 8000 });
      const m = String(stdout).match(/"api_token"\s*:\s*"(cicy_[A-Za-z0-9]+)"/);
      if (m) { say("done", t("dockerOpen.tokVolHit", { n: attempt })); return m[1]; }
      say("running", t("dockerOpen.tokVolMiss"));
    } catch (e) { say("running", t("dockerOpen.tokVolErr", { err: e.message })); }
    // 2) Fallback: exec into the container.
    say("running", `$ wsl -d ${DISTRO} -- ${execCmd}`);
    try {
      const { stdout } = await wslRun(execCmd, { timeout: 10000 });
      const tok = JSON.parse(stdout).api_token || "";
      if (tok) { say("done", t("dockerOpen.tokExecHit", { n: attempt })); return tok; }
      say("running", t("dockerOpen.tokExecMiss"));
    } catch (e) { say("running", t("dockerOpen.tokExecErr", { err: e.message })); }
    if (attempt < 5) { say("running", t("dockerOpen.tokRetry", { n: attempt })); await new Promise((r) => setTimeout(r, 2000)); }
  }
  say("error", t("dockerOpen.tokFail"));
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
  // **:8009 健康优先,且永不静默**(主人: 出了问题要看得到、能排查):
  // 先独立 HTTP 探活 —— 哪怕 `wsl --list` 抽风查不到发行版(实测:WSL/Windows 更新会把
  // 正在跑的发行版孤儿化,管理命令报「没有已安装的分发版」,但容器还在后台服务 :8009),
  // 只要 :8009 真健康,就是 running、卡片就给「打开」。同时把这种「服务在跑但 WSL 管不到」
  // 的异常用 wslUnmanaged 标出来,卡片显式提示「运行中·WSL 管理异常,更新/重启需修复」,
  // 不再让用户面对一个打不开、没报错的死卡。
  const healthy = await probeHealth(port);
  const miss = await docker.wslMissing();           // true | false | null(unknown)
  if (miss === null) return { wsl: false, distro: false, engineUp: false, running: healthy, unknown: !healthy, healthy, wslUnmanaged: healthy };
  const wsl = !miss;
  let distro = false, unknown = false;
  if (wsl) {
    const di = await distroInstalled();             // true | false | null(unknown)
    if (di === null) unknown = true; else distro = !!di;
  }
  const engineUp = !!(distro && (await dockerEngineUp()));
  const running = healthy || !!(engineUp && (await probeHealth(port)));
  // 服务在跑(:8009 健康)但 wsl 查不到发行版/引擎 → WSL 被孤儿化,管理(更新/重启)会失败。
  const wslUnmanaged = healthy && !engineUp;
  return { wsl, distro, engineUp, running, unknown: unknown && !healthy, healthy, wslUnmanaged };
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

// 注意: 默认容器/卷名保持 cicy-team / cicy-code-docker(回退主人实测"现在不行了"的改动)。
// live 路径(docker:app-bootstrap)始终传显式 APP_*(cicy-team-8009)名,不靠这里的默认;
// 改默认会让既有 cicy-team 卷的装机对不上 → 退回原值。
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

  // 0) Fast path: healthy AND the distro is TRULY wsl-managed → instant no-op.
  //    BUT a ZOMBIE :8009 (distro unregistered from WSL, yet a leftover wslhost.exe
  //    still holds the port-forward → health 200 even after `wsl --shutdown`) is NOT
  //    a working install: token can't be read, 「打开」would fail forever. Only skip
  //    on health when distroInstalled() is CONFIRMED true; if it's CONFIRMED false
  //    (wsl --list worked and the distro is gone) → zombie: kill the port squatter +
  //    `wsl --shutdown`, then fall through to a full re-import. `null`(flaky list)→
  //    treat as maybe-fine, keep the old health-only no-op (don't nuke a good setup).
  begin("probe-healthy");
  const healthy0 = await probeHealth(port);
  const di0 = healthy0 ? await distroInstalled() : null; // true | false | null
  if (healthy0 && di0 !== false) {
    done();
    emit({ phase: "done", status: "done", message: "Docker cicy-code 已就绪 🎉" });
    finish(true);
    return { ok: true, container };
  }
  if (healthy0 && di0 === false) {
    emit({ phase: "container", status: "running", message: "检测到 :8009 被僵尸进程占用(WSL 已无此发行版),正在清理端口 + 重置 WSL 后重装…" });
    try { await killPortListener(port); } catch (e) {}
    try { await wslShutdown(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 1500));
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
    try { await installDistro({ emit }); } catch (e) { fail("distro_install_failed", e.message); emit({ phase: "install-docker", status: "error", message: `Ubuntu 安装失败：${e.message}（点重试）${errTail(e)}` }); finish(false, "distro_install_failed"); return { ok: false, reason: "distro_install_failed" }; }
    const t0 = Date.now();
    const ok = await docker.waitUntil(() => distroInstalled(), { totalMs: 600000, everyMs: 5000, onTick: () => emit({ phase: "install-docker", status: "running", message: `正在下载/注册 Ubuntu…（已 ${Math.round((Date.now() - t0) / 1000)}s,首次较慢请耐心）` }) });
    if (!ok) { fail("distro_not_ready"); emit({ phase: "install-docker", status: "error", message: "Ubuntu 还没装好——稍等或点「重试」" }); finish(false, "distro_not_ready"); return { ok: false, reason: "distro_not_ready" }; }
    done();
  } else done(true);

  // 3) Docker Engine inside Ubuntu
  begin("install-docker-engine");
  if (!(await dockerInstalled())) {
    try { await installDockerEngine({ emit }); } catch (e) { fail("docker_install_failed", e.message); emit({ phase: "install-docker", status: "error", message: `Docker 安装失败：${e.message}（点重试）${errTail(e)}` }); finish(false, "docker_install_failed"); return { ok: false, reason: "docker_install_failed" }; }
    done();
  } else done(true);

  // 4) dockerd up (phase "container" = 启动服务)
  begin("start-dockerd");
  if (!(await dockerEngineUp())) {
    emit({ phase: "container", status: "running", message: "启动 Docker 引擎（首次较慢，请耐心）…" });
    const started = await startEngine({ emit }); // 3 clean attempts internally
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

  // 5) Base image — pre-baked into the package, normally just confirms; but if the
  //    OSS tarball has a newer build (ETag changed) it refreshes (主人:别卡旧镜像)。
  begin("ensure-image");
  try { await ensureFreshImage({ emit }); done(); }
  catch (e) {
    if (!(await imagePresent())) { fail("image_download_failed", e.message); emit({ phase: "image", status: "error", message: `镜像下载失败：${e.message}（点重试续传）${errTail(e)}` }); finish(false, "image_download_failed"); return { ok: false, reason: "image_download_failed" }; }
    emit({ phase: "image", status: "running", message: `镜像刷新失败（${e.message}），沿用现有镜像` }); done(true);
  }

  // 6) Container (phase "container" = 启动服务)
  begin("run-container");
  if (!(await probeHealth(port))) {
    emit({ phase: "container", status: "running", message: "启动 cicy-code 服务…" });
    try { await runContainer({ port, container, volume, env, emit }); }
    catch (e) { fail("container_start_failed", e.message); emit({ phase: "container", status: "error", message: `服务启动失败：${e.message}（点重试）${errTail(e)}` }); finish(false, "container_start_failed"); return { ok: false, reason: "container_start_failed" }; }
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
async function recreate({ onProgress, port = 8009, container = "cicy-code-docker-8009", volume = "cicy-team-8009", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  // 重建 = 用最新镜像重建。OSS 有更新版先刷新(非破坏性,不删发行版/volume),再 rm + run。
  try { await ensureFreshImage({ emit }); } catch (e) { emit({ phase: "image", status: "running", message: `镜像刷新跳过(${e.message}),用现有镜像重建` }); }
  // 强删占用该端口的**任何**容器(含老名字 cicy-code-docker)+ 目标容器 —— 否则
  // runContainer 开头的 probeHealth 看到旧容器还健康会 adopt 它、不重建,key 就换不了。
  try { await wslRun(`docker ps -aq --filter publish=${port} | xargs -r docker rm -f 2>/dev/null; docker rm -f ${container} 2>/dev/null; true`, { timeout: 30000 }); } catch {}
  const r = await runContainer({ port, container, volume, env, emit });
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

// 容器里有没有注入网关 key(reconcile 自愈用):printenv 看 CICY_AI_GATEWAY_LLM_API_KEY。
async function hasGatewayKey(container = "cicy-code-docker") {
  try { const { stdout } = await wslRun(`docker exec ${container} printenv CICY_AI_GATEWAY_LLM_API_KEY`, { timeout: 8000 }); return /sk-/.test(String(stdout || "")); }
  catch { return false; }
}

// 读容器里 cicy-code 生成的 mihomo.yaml(host-mihomo 用它在 Windows 宿主重建 Chrome 代理配置)。
async function readMihomoConfig(container = "cicy-code-docker-8009") {
  const { stdout } = await wslRun(`docker exec ${container} cat /home/cicy/cicy-ai/db/mihomo.yaml`, { timeout: 15000 });
  return String(stdout || "");
}

module.exports = {
  bootstrap, status, restart, stop, dockerRestart, recreate, update, upgrade, runContainer, readContainerToken,
  distroInstalled, dockerInstalled, dockerEngineUp, imagePresent, probeHealth, wslRun, hasGatewayKey,
  readMihomoConfig,
};
