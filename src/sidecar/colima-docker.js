// Docker-版 cicy-code on macOS via Colima (Lima 轻量 VM + Docker 引擎).
//
// macOS 没有 WSL。对应 Windows 端「不装 Docker Desktop GUI、用确定性命令驱动
// Docker 引擎」的方案,在 Mac 上就是 Colima:一个 Apache-2.0、纯 CLI、无 GUI、
// 无授权、无 root 的轻量 Linux VM(基于 Lima),里面跑标准 Docker 引擎。Lima 会
// 把 VM 内监听 127.0.0.1 的端口自动转发到宿主 127.0.0.1,所以 VM 里发布在
// :8009 的容器,Mac 上 127.0.0.1:8009 直接可达——和 WSL2 的 localhost 转发等价。
//
// 与 wsl-docker.js 完全同接口(bootstrap/status/restart/stop/dockerRestart/
// recreate/update/upgrade/runContainer/readContainerToken),由 sidecar-ipc.js
// 按平台分发:darwin → 本模块,win32 → wsl-docker.js。
//
// 关键设计:
//   • 单 Colima profile `cicy-code` 托管多个容器(按端口区分)——不一 docker 一 VM,
//     呼应 Windows「一个 distro、多容器」的模型。
//   • Apple Silicon(arm64)上 cicy-code 镜像是 amd64 → `colima start --vm-type vz
//     --vz-rosetta` + `docker run --platform linux/amd64`,靠 Apple 虚拟化框架 +
//     Rosetta 跑 x86 容器(快、不改镜像)。Intel(x64)原生 amd64,无需 rosetta。
//   • 容器 /home/cicy 用 host bind-mount(~/cicy-ai/docker-volumes/<volume>)而非
//     docker named volume → 文件直接落在 Mac 文件系统,Finder 可直接打开,
//     readContainerToken 也能直接读宿主文件(比 docker exec 稳)。宿主目录 chmod 777
//     规避 virtiofs 的 uid 映射导致容器(uid 1000)写不进去的问题。

const { execFile, spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const docker = require("./docker"); // 共享:downloadImageTarball / curlDownload / probeHealth / waitUntil / downloadsDir

// 专用 Colima profile —— 绝不动用户自己的默认 colima/docker。
const PROFILE = process.env.CICY_COLIMA_PROFILE || "cicy-code";
// Colima 给每个 profile 建一个 docker context,名字是 `colima-<profile>`。所有
// docker 命令都显式 --context,绝不污染用户的默认 context。
const CTX     = `colima-${PROFILE}`;
const IMAGE   = process.env.CICY_DOCKER_IMAGE || "cicybot/cicy-code:latest";
// Apple Silicon 需要给 amd64 镜像加 --platform;Intel 原生 amd64 不用。
const IS_ARM  = process.arch === "arm64";
const ARCH_TAG = IS_ARM ? "arm64" : "amd64";
const PLATFORM_FLAG = IS_ARM ? "--platform linux/amd64" : "";

// Colima 基础 VM 镜像:colima `start` 默认从 github.com/abiosoft/colima-core 下,
// CN 直接 EOF 拉不下来(真机实测)。colima 0.10.3 没有 --disk-image-mirror(那是
// main 分支才有),但有 `--disk-image <本地文件> --force-disk-image` —— 所以我们把
// 基础镜像托到自己的 OSS(CN-fast),先下到本地,再用 --disk-image 指过去,彻底绕开
// github。--force-disk-image 让 colima 不去校验它「不是我预期版本」。镜像内容只要是
// ubuntu-24.04 + docker 的 cloudimg 即可,和 colima 版本解耦(用稳定 key,不跟版本号)。
const OSS_BASE = process.env.CICY_OSS_BASE || "https://cicy-1372193042-cn.oss-cn-shanghai.aliyuncs.com";
const BASE_IMAGE_URL = process.env.CICY_COLIMA_BASE_URL ||
  `${OSS_BASE}/colima-base/ubuntu-2404-${ARCH_TAG}-docker.raw.gz`;
function baseImagePath() { return path.join(os.homedir(), "cicy-ai", "colima", `ubuntu-2404-${ARCH_TAG}-docker.raw.gz`); }

// Electron 启动时 PATH 往往不含 Homebrew 的 bin,导致找不到 brew/colima/docker。
// 显式把两个 Homebrew 前缀(Apple Silicon=/opt/homebrew,Intel=/usr/local)拼进 PATH。
const BREW_PATHS = "/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/sbin:/usr/local/sbin";
function shEnv() { return { ...process.env, PATH: `${BREW_PATHS}:${process.env.PATH || ""}` }; }

// 在 Mac 宿主跑一条 bash 命令(execFile,无壳注入;命令串原样交给 bash -lc)。
function sh(cmd, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-lc", cmd], { timeout, env: shEnv(), maxBuffer: 1 << 26 },
      (err, stdout, stderr) => {
        if (err) { err.stdout = String(stdout || ""); err.stderr = String(stderr || ""); return reject(err); }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

// 同 sh,但把每行实时推给安装抽屉,让用户看到 brew 安装 / colima start /
// docker load 的真实进度,而不是盯着假死的 spinner。节流防刷屏。
function shStream(cmd, { emit, phase = "install-docker", timeout = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", cmd], { env: shEnv() });
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

// 针对 colima profile 的 docker 命令(始终 --context CTX,不碰用户默认 context)。
function dk(args, opts) { return sh(`docker --context ${CTX} ${args}`, opts); }

// ---- 平台/依赖检测 -------------------------------------------------------

function hasCmd(name) { return sh(`command -v ${name} >/dev/null 2>&1`, { timeout: 8000 }).then(() => true, () => false); }
function brewInstalled()   { return hasCmd("brew"); }
function colimaInstalled()  { return hasCmd("colima"); }
function dockerCliInstalled(){ return hasCmd("docker"); }

// Homebrew 缺失:没法静默装(需要交互 + Xcode Command Line Tools)。给出明确指引,
// 让卡片把这步交还给用户,而不是假装在装。
async function ensureBrew({ emit } = {}) {
  if (await brewInstalled()) return true;
  emit && emit({ phase: "install-docker", status: "error",
    message: "未检测到 Homebrew —— 请先在「终端」执行安装:\n" +
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n' +
      "装好后回来点「重试」。" });
  return false;
}

// brew install colima docker(幂等;已装则秒过)。docker 这个 formula 只是 CLI,
// Docker 引擎本体由 colima 在 VM 里提供。
async function installColima({ emit } = {}) {
  emit && emit({ phase: "install-docker", status: "running", message: "通过 Homebrew 安装 Colima 与 docker CLI(几分钟,下面是实时进度)…" });
  await shStream("brew install colima docker 2>&1", { emit, phase: "install-docker", timeout: 1200000 });
}

// ---- Colima VM 生命周期 --------------------------------------------------

// profile 是否已创建(无论是否在跑)。`colima list` 列出所有 profile。
async function vmExists() {
  try { const { stdout } = await sh(`colima list 2>/dev/null`, { timeout: 15000 });
    return String(stdout).split(/\r?\n/).some((l) => l.trim().split(/\s+/)[0] === PROFILE);
  } catch { return false; }
}

// VM 在跑且 Docker 引擎可达?
async function engineUp() {
  try { await dk(`version --format '{{.Server.Version}}'`, { timeout: 10000 }); return true; }
  catch { return false; }
}

// 确保 Colima 基础 VM 镜像已从 OSS 下到本地(只在 VM 不存在时需要;已有 VM 直接复用
// 它的磁盘)。返回本地路径供 --disk-image 用。下过且大小一致就跳过(幂等续传)。
async function ensureBaseImage({ emit } = {}) {
  const dest = baseImagePath();
  try {
    const st = fs.statSync(dest);
    // 简单完整性:>200MB 认为已下好(ubuntu-2404 docker cloudimg ~340MB)。
    if (st.size > 200 * 1024 * 1024) return dest;
  } catch {}
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 用共享的 curlDownload(和 Windows 下载 rootfs/镜像同一个),它每秒 emit
  // { progress, received, total } → 抽屉渲染**进度条**(之前我用裸 curl 没进度,
  // 主人看到的就是没进度条)。续传 + 重试都在里头。
  await docker.curlDownload(BASE_IMAGE_URL, dest, { emit, phase: "image", label: "下载运行环境基础镜像(约 340MB,从 OSS)" });
  return dest;
}

// 启动(或创建)Colima VM。Apple Silicon 用 vz + rosetta 跑 amd64;Intel 原生。
// 带 3 次干净重试:冷启动偶尔卡在初始化,重启一次就好(对应 wsl 端 startEngine 的
// 「一次起不来、要点重试」根因)。vz 需要 macOS 13+,失败则回退默认(qemu)。
//
// 不再 --mount $HOME:w:/home/cicy 改用 docker **named volume**(见 runContainer 注释),
// 不需要把宿主目录挂进来;docker load / --disk-image 都由宿主侧的 CLI/colima 读本地文件,
// 也不需要挂载。少挂一个 $HOME 更干净更安全。
async function startVM({ emit } = {}) {
  // 基础镜像从 OSS 下到本地,用 --disk-image 指过去(绕开 github),--force-disk-image
  // 让 colima 不校验版本。已有 VM 时 ensureBaseImage 仍是幂等的(命中本地缓存秒过)。
  let diskArgs = "";
  try { const img = await ensureBaseImage({ emit }); diskArgs = `--disk-image ${JSON.stringify(img)} --force-disk-image`; }
  catch (e) { emit && emit({ phase: "image", status: "running", message: `基础镜像下载异常(${e.message}),尝试用 colima 默认源…` }); }
  const vzArgs = IS_ARM
    ? `--vm-type vz --vz-rosetta --mount-type virtiofs`
    : `--vm-type vz --mount-type virtiofs`;
  const common = `--cpus 2 --memory 4 --disk 30 ${diskArgs}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    emit && emit({ phase: "container", status: "running", message: `启动 Colima 运行环境(首次较慢,请耐心)…${attempt > 1 ? `(重试 ${attempt})` : ""}` });
    try {
      // 已存在的 profile:`colima start -p NAME` 直接拉起,忽略多余的 create 参数。
      await shStream(`colima start -p ${PROFILE} ${vzArgs} ${common} 2>&1`, { emit, phase: "container", timeout: 900000 });
    } catch (e1) {
      // vz 不可用(老 macOS)→ 回退默认 hypervisor(qemu)。
      emit && emit({ phase: "container", status: "running", message: "vz 不可用,回退默认虚拟化重试…" });
      try { await shStream(`colima start -p ${PROFILE} ${common} 2>&1`, { emit, phase: "container", timeout: 900000 }); } catch {}
    }
    if (await engineUp()) return true;
    // 没起来:停掉半死的 VM,清场后重试。
    try { await sh(`colima stop -p ${PROFILE} 2>/dev/null; true`, { timeout: 60000 }); } catch {}
  }
  return false;
}

// colima 启动日志尾巴(诊断「引擎没起来」)。
async function colimaLogTail() {
  try {
    const { stdout } = await sh(`tail -n 25 "$HOME/.colima/${PROFILE}/colima.log" 2>/dev/null || tail -n 25 "$HOME/.colima/_lima/colima-${PROFILE}/serial.log" 2>/dev/null`, { timeout: 8000 });
    return String(stdout || "").trim();
  } catch { return ""; }
}

// ---- 镜像 ----------------------------------------------------------------

async function imagePresent() {
  try { await dk(`image inspect ${IMAGE} >/dev/null 2>&1`, { timeout: 10000 }); return true; }
  catch { return false; }
}

// docker load 镜像 tarball 到 colima 的 Docker(复用 docker.js 下载到的 R2 包)。
async function loadImage(tarball, { emit } = {}) {
  emit && emit({ phase: "image", status: "loading", message: "正在导入镜像到 Docker(较大,约 1-3 分钟,下面是实时进度)…" });
  const { stdout } = await shStream(`docker --context ${CTX} load -i ${JSON.stringify(tarball)}`, { emit, phase: "image", timeout: 600000 });
  const m = String(stdout).match(/Loaded image:\s*(\S+)/i);
  if (m && m[1] !== IMAGE) { try { await dk(`tag ${m[1]} ${IMAGE}`, { timeout: 15000 }); } catch {} }
}

// 宿主 127.0.0.1:port 健康探针 —— Lima 自动把 VM 内 127.0.0.1 端口转发到宿主。
const probeHealth = docker.probeHealth;

// ---- 容器 ----------------------------------------------------------------

// 启动(或沿用):port 上的容器。与 wsl 端对齐:
//   • -p 127.0.0.1:<port>:8008 只发布回环,api_token 把门;Lima 自动把 VM 内
//     127.0.0.1:<port> 转发到宿主 127.0.0.1:<port>(真机实测通);
//   • CICY_PUBLIC=1 让 cicy-code 在容器内绑 0.0.0.0:8008(否则 docker-proxy 够不到);
//   • Apple Silicon 加 --platform linux/amd64(rosetta 跑 x86 容器);
//   • /home/cicy 必须用 docker **named volume**,不能用 host bind-mount!真机实测:
//     bind-mount 会用空的宿主目录**遮住镜像里预装的 /home/cicy**(cicy-code 装在那),
//     entrypoint 找不到就试图全局 npm 重装 → EACCES 崩溃,:8009 起不来。named volume
//     首次挂载会**从镜像内容预填充**,容器才看得到预装的 cicy-code(和 WSL 一致)。
// Shared folder bind: the CURRENT macOS user's ~/Desktop/Share ↔
// /home/cicy/cicy-ai/Share in the container. Auto-created (with a readme) on every
// container start if missing; os.homedir() makes it per-user. Colima mounts the
// host $HOME into the VM, so the direct path works (no /mnt translation like WSL).
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
    const share = path.join(os.homedir(), "Desktop", "Share");
    fs.mkdirSync(share, { recursive: true });
    const readme = path.join(share, "readme.md");
    if (!fs.existsSync(readme)) { try { fs.writeFileSync(readme, SHARE_README); } catch {} }
    return `-v '${share}':/home/cicy/cicy-ai/Share`;
  } catch { return ""; }
}

async function runContainer({ port = 8009, container = "cicy-code-docker-8009", volume = "cicy-team-8009", env = {} } = {}) {
  if (await probeHealth(port)) return { adopted: true };
  try { await dk(`rm -f ${container}`, { timeout: 20000 }); } catch {} // 替换同名残留容器
  const envArgs = Object.entries(env || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `-e ${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  // 主人(A 方案): 映射 mihomo 的 per-Chrome-profile 监听口段(约定 20000+N)回主机回环。
  // docker-only 后 mihomo 只在容器里,这些口不暴露则主机系统 Chrome 的代理 127.0.0.1:(20000+N)
  // 连不上。默认 20001-20032(32 个 profile),CICY_CHROME_PROXY_PORTS 可调。
  const CHROME_PROXY_PORTS = process.env.CICY_CHROME_PROXY_PORTS || "20001-20032";
  const cmd = `run -d --name ${container} --restart unless-stopped ${PLATFORM_FLAG} ` +
    `-p 127.0.0.1:${port}:8008 -p 127.0.0.1:${CHROME_PROXY_PORTS}:${CHROME_PROXY_PORTS} -e CICY_PUBLIC=1 -v ${volume}:/home/cicy ${shareMountArg()} ${envArgs} ${IMAGE}`;
  await dk(cmd, { timeout: 90000 });
  return { started: true };
}

// 读容器自己的 api_token —— :port 唯一正确的凭证(宿主 8008 的 token 不通用)。
// named volume 的数据在 VM 内,读两条路(都真机实测过):① colima ssh 直读 VM 里
// 该卷的 _data/cicy-ai/global.json(最稳,避开 busy 容器的慢 exec);② 退回 docker
// exec。重试到 entrypoint 把 global.json 写出来为止;真读不到返回 ""(调用方不得拿
// 错/宿主 token 去开,会卡登录)。
async function readContainerToken(port = 8009, container = "cicy-code-docker-8009", volume = "cicy-team-8009") {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { const { stdout } = await sh(`colima ssh -p ${PROFILE} -- sudo cat /var/lib/docker/volumes/${volume}/_data/cicy-ai/global.json 2>/dev/null`, { timeout: 10000 });
      const m = String(stdout).match(/"api_token"\s*:\s*"(cicy_[A-Za-z0-9]+)"/);
      if (m) return m[1];
    } catch { /* VM 还没就绪 — 重试 */ }
    try { const { stdout } = await dk(`exec ${container} cat /home/cicy/cicy-ai/global.json`, { timeout: 10000 });
      const tok = JSON.parse(stdout).api_token || ""; if (tok) return tok;
    } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "";
}

// ---- 开机自启 + Finder 入口 ---------------------------------------------

// launchd LaunchAgent:登录时 `colima start -p PROFILE` 拉起 VM(老 inbox WSL 那套
// schtasks 的 Mac 对应物)。VM 起来后容器的 --restart unless-stopped 自动恢复 cicy-code。
async function ensureAutostart() {
  if (process.platform !== "darwin") return;
  try {
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    fs.mkdirSync(dir, { recursive: true });
    const label = `com.cicy.colima.${PROFILE}`;
    const plist = path.join(dir, `${label}.plist`);
    // 用 /bin/bash 包一层把 brew PATH 带上,确保找得到 colima。
    const colimaCmd = `export PATH=${BREW_PATHS}:$PATH; colima start -p ${PROFILE}`;
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0"><dict>\n` +
      `  <key>Label</key><string>${label}</string>\n` +
      `  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>${colimaCmd}</string></array>\n` +
      `  <key>RunAtLoad</key><true/>\n` +
      `</dict></plist>\n`;
    fs.writeFileSync(plist, xml);
    try { await sh(`launchctl unload ${JSON.stringify(plist)} 2>/dev/null; launchctl load -w ${JSON.stringify(plist)}`, { timeout: 15000 }); } catch {}
  } catch {}
}

// 桌面文件入口:Mac 上 /home/cicy 是 docker named volume(数据在 Colima VM 内,
// 不在 Mac 文件系统上),Finder 没法像 WSL 的 \\wsl$ 那样直接浏览。所以 Mac 端
// 暂不放桌面快捷方式(放了也是死链)。要看文件用 `colima ssh -p cicy-code` 进 VM,
// 或后续做一个 sshfs/虚拟挂载再补。保留空实现,调用点无需改。
async function ensureDesktopShortcut(_volume, _port) { /* no-op on darwin: named volume lives inside the VM */ }

// ---- 卡片状态 ------------------------------------------------------------

// 与 wsl status 同形 { wsl, distro, engineUp, running },供 sidecar-ipc 复用:
//   wsl    → 平台/依赖就绪(brew+colima+docker CLI 都在)
//   distro → VM(profile)已创建
async function status(port = 8009) {
  const deps   = (await colimaInstalled()) && (await dockerCliInstalled());
  const vm     = deps && (await vmExists());
  const up     = vm && (await engineUp());
  const running= up && (await probeHealth(port));
  return { wsl: deps, distro: vm, engineUp: up, running };
}

// ---- bootstrap(一次性幂等装机) ----------------------------------------

let _bootstrapInFlight = null;
async function bootstrap(opts = {}) {
  if (_bootstrapInFlight) {
    try { opts.onProgress && opts.onProgress({ phase: "install-docker", status: "running", message: "安装已在进行中,正在跟随同一进度…" }); } catch {}
    return _bootstrapInFlight;
  }
  _bootstrapInFlight = _bootstrap(opts).finally(() => { _bootstrapInFlight = null; });
  return _bootstrapInFlight;
}

async function _bootstrap({ onProgress, port = 8009, container = "cicy-code-docker-8009", volume = "cicy-team-8009", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };

  // 0) 快路径:已健康 → 秒返回(幂等)。
  if (await probeHealth(port)) { emit({ phase: "done", status: "done", message: "Docker cicy-code 已就绪 🎉" }); return { ok: true, container }; }

  // 1) Homebrew(缺了没法静默装)
  if (!(await ensureBrew({ emit }))) return { ok: false, reason: "brew_missing" };

  // 2) Colima + docker CLI
  if (!(await colimaInstalled()) || !(await dockerCliInstalled())) {
    try { await installColima({ emit }); }
    catch (e) { emit({ phase: "install-docker", status: "error", message: `Colima 安装失败:${e.message}(点重试)` }); return { ok: false, reason: "colima_install_failed" }; }
  }

  // 3) VM 起来 + Docker 引擎可达
  if (!(await engineUp())) {
    const up = await startVM({ emit });
    if (!up) {
      const log = await colimaLogTail();
      emit({ phase: "container", status: "error", message: "Docker 引擎没起来——点「重试」" + (log ? `\n\ncolima 日志(最后几行):\n${log}` : "") });
      return { ok: false, reason: "engine_not_up" };
    }
  }

  // 4) 镜像(docker load R2 包)
  if (!(await imagePresent())) {
    let tarball;
    try { tarball = await docker.downloadImageTarball({ emit }); }
    catch (e) { emit({ phase: "image", status: "error", message: `镜像下载失败:${e.message}(点重试续传)` }); return { ok: false, reason: "image_download_failed" }; }
    try { await loadImage(tarball, { emit }); }
    catch (e) { emit({ phase: "image", status: "error", message: `镜像导入失败:${e.message}(点重试)` }); return { ok: false, reason: "image_load_failed" }; }
  }

  // 5) 容器
  if (!(await probeHealth(port))) {
    emit({ phase: "container", status: "running", message: "启动 cicy-code 服务…" });
    try { await runContainer({ port, container, volume, env }); }
    catch (e) { emit({ phase: "container", status: "error", message: `服务启动失败:${e.message}(点重试)` }); return { ok: false, reason: "container_start_failed" }; }
  }

  // 6) 健康 —— 唯一通往 ok:true 的路。
  emit({ phase: "container", status: "running", message: "等待 cicy-code 就绪…" });
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  if (healthy) { await ensureAutostart(); await ensureDesktopShortcut(volume, port); }
  emit({ phase: healthy ? "done" : "container", status: healthy ? "done" : "error", message: healthy ? "Docker cicy-code 已就绪 🎉" : `服务起来了但 :${port} 还没响应——稍等或点「重试」` });
  return { ok: healthy, container };
}

// ---- 生命周期(卡片 ⋯ 菜单)--------------------------------------------

// 仅重启容器内的 cicy-code 进程(supervisor),cron/sshd 等不动;退回整容器重启。
async function restart({ container = "cicy-code-docker-8009", port = 8009, volume = "cicy-team-8009" } = {}) {
  await startVM({});
  try { await dk(`exec ${container} supervisorctl -c /etc/supervisor/supervisord.conf restart cicy-code`, { timeout: 30000 }); }
  catch { try { await dk(`restart ${container}`, { timeout: 60000 }); } catch {} }
  const ok = await docker.waitUntil(() => probeHealth(port), { totalMs: 60000, everyMs: 2000 });
  if (ok) await ensureDesktopShortcut(volume, port);
  return ok;
}

// 原地更新 cicy-code(镜像内的 cicy-code-update.sh,不重建容器)。
async function update({ onProgress, container = "cicy-code-docker-8009", port = 8009 } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  await startVM({});
  emit({ phase: "image", status: "running", message: "更新 cicy-code(拉取最新版)…" });
  try {
    await shStream(`docker --context ${CTX} exec ${container} bash -lc "command -v cicy-code-update.sh >/dev/null && cicy-code-update.sh || /usr/local/bin/cicy-code-update.sh"`,
      { emit, phase: "image", timeout: 300000 });
  } catch (e) { emit({ phase: "done", status: "error", message: `更新失败:${e.message}(试试「升级」重装)` }); return { ok: false, reason: "update_failed" }; }
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? "cicy-code 已更新到最新 🎉" : "更新了但 :8009 还没响应——稍等或点重试" });
  return { ok: healthy };
}

async function stop({ container = "cicy-code-docker-8009" } = {}) {
  try { await dk(`stop ${container}`, { timeout: 30000 }); } catch {}
}

// docker restart 整个容器(entrypoint 重跑、重读 volume global.json)。
async function dockerRestart({ container = "cicy-code-docker-8009" } = {}) {
  await dk(`restart ${container}`, { timeout: 45000 });
  return true;
}

// 重建:强删占该端口的任何容器 + 目标容器,再 docker run(用新 env,如新 docker team
// 网关 key)。保留 bind-mount 宿主目录(数据/api_token 不丢)。破坏性 → 调用方要 confirm。
async function recreate({ port = 8009, container = "cicy-code-docker-8009", volume = "cicy-team-8009", env = {} } = {}) {
  try { await dk(`ps -aq --filter publish=${port} | xargs -r docker --context ${CTX} rm -f 2>/dev/null; docker --context ${CTX} rm -f ${container} 2>/dev/null; true`, { timeout: 30000 }); } catch {}
  const r = await runContainer({ port, container, volume, env });
  try { await ensureDesktopShortcut(volume, port); } catch {}
  return r;
}

// 升级 = 删 VM 重装(重置;cicy-team 数据随之重置,实例重新 seed 出新 token)。
async function upgrade({ onProgress, port = 8009, container = "cicy-code-docker-8009", volume = "cicy-team-8009", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  emit({ phase: "install-docker", status: "running", message: "升级 = 重装运行环境(会重置容器数据)…" });
  try { await sh(`colima delete -f -p ${PROFILE} 2>/dev/null; true`, { timeout: 120000 }); } catch {}
  return await _bootstrap({ onProgress, port, container, volume, env });
}

// 容器里有没有注入网关 key(reconcile 自愈用):printenv 看 CICY_AI_GATEWAY_LLM_API_KEY。
async function hasGatewayKey(container = "cicy-code-docker-8009") {
  try { const { stdout } = await dk(`exec ${container} printenv CICY_AI_GATEWAY_LLM_API_KEY`, { timeout: 8000 }); return /sk-/.test(String(stdout || "")); }
  catch { return false; }
}

module.exports = {
  bootstrap, status, restart, stop, dockerRestart, recreate, update, upgrade, runContainer, readContainerToken,
  vmExists, colimaInstalled, dockerCliInstalled, engineUp, imagePresent, probeHealth, hasGatewayKey,
};
