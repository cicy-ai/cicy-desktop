// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Docker-版 cicy-code on macOS via Colima (Lima 轻量 VM + Docker 引擎).
//
// macOS 没有 WSL。对应 Windows 端「不装 Docker Desktop GUI、用确定性命令驱动
// Docker 引擎」的方案,在 Mac 上就是 Colima:一个 Apache-2.0、纯 CLI、无 GUI、
// 无授权、无 root 的轻量 Linux VM(基于 Lima),里面跑标准 Docker 引擎。Lima 会
// 把 VM 内监听 127.0.0.1 的端口自动转发到宿主 127.0.0.1,所以 VM 里发布在
// :8008 的容器,Mac 上 127.0.0.1:8008 直接可达——和 WSL2 的 localhost 转发等价。
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
// 容器额外暴露的端口段(给容器内 agent 跑服务用),宿主 127.0.0.1 直达。
const EXTRA_PORTS = process.env.CICY_EXTRA_PORTS || "18000-19999";
// Colima VM 资源,4C8G 起步(可用 env 覆盖,不写死)。
const VM_CPUS   = process.env.CICY_COLIMA_CPUS   || "4";
const VM_MEMORY = process.env.CICY_COLIMA_MEMORY || "8";
const VM_DISK   = process.env.CICY_COLIMA_DISK   || "30";

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

// Homebrew 默认前缀(按 arch):Apple Silicon=/opt/homebrew,Intel=/usr/local。
// brew 二进制装完落在 <prefix>/bin/brew —— 已经在 BREW_PATHS 里,装完即可被 command -v 找到。
const BREW_PREFIX  = IS_ARM ? "/opt/homebrew" : "/usr/local";
// Homebrew 源码 tarball:官方「Untar anywhere」装法(解压即用,不走 git clone,不需要
// Xcode/CLT —— colima/docker 都是预编译 bottle,无编译步骤)。可用环境变量换 CN 镜像。
const BREW_TARBALL = process.env.CICY_BREW_TARBALL || "https://github.com/Homebrew/brew/tarball/master";

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

// 自动装 Homebrew —— 纯 App 内,不甩给用户一条命令、也不假装在装。
// 难点:GUI 启动的 Electron 没有 tty,sudo 弹不出密码框。所以唯一的特权操作(建前缀 +
// chown 给当前用户)用 osascript「with administrator privileges」弹一次原生系统密码框完成;
// 之后用官方「Untar anywhere」把 brew 解压进自己拥有的前缀,全程不再需要 sudo。
async function autoInstallBrew({ emit } = {}) {
  const user = os.userInfo().username;

  // 1) 一次性提权:建前缀 + chown(弹系统密码框)。AppleScript 写临时文件再 osascript,
  //    避开 bash→osascript→shell 三层嵌套引号。
  emit && emit({ phase: "install-docker", status: "running",
    message: "安装 Homebrew:即将弹出系统密码框,请输入你的 Mac 登录密码授权…" });
  const scpt = path.join(os.tmpdir(), "cicy-brew-prep.applescript");
  fs.writeFileSync(scpt,
    `do shell script "mkdir -p '${BREW_PREFIX}' && chown -R '${user}':admin '${BREW_PREFIX}'" ` +
    `with administrator privileges with prompt "CiCy Desktop 需要管理员权限来安装 Homebrew(只需输入一次 Mac 登录密码)"`);
  try {
    await sh(`osascript ${JSON.stringify(scpt)}`, { timeout: 180000 });
  } catch (e) {
    const why = String(e.stderr || e.message || "");
    const cancelled = /-128|User canceled|用户.*取消/i.test(why);
    emit && emit({ phase: "install-docker", status: "error",
      message: cancelled ? "已取消授权 —— 安装 Homebrew 需要管理员密码,点「重试」再来一次。"
                         : `获取管理员权限失败:${why.slice(0, 160)}(点重试)` });
    return false;
  } finally { try { fs.unlinkSync(scpt); } catch {} }

  // 2) 解压 Homebrew 进前缀(Untar anywhere,无 sudo)。brew 落在 <prefix>/bin/brew。
  emit && emit({ phase: "install-docker", status: "running", message: "下载并解压 Homebrew…" });
  try {
    await shStream(
      `curl -fL --retry 3 ${JSON.stringify(BREW_TARBALL)} | tar xz --strip-components 1 -C ${JSON.stringify(BREW_PREFIX)} 2>&1`,
      { emit, phase: "install-docker", timeout: 600000 });
  } catch (e) {
    emit && emit({ phase: "install-docker", status: "error",
      message: `Homebrew 下载/解压失败:${String(e.stdout || e.message || "").slice(-160)}(点重试)` });
    return false;
  }

  // 3) 验证能跑(顺手关掉首次 install 的隐式 auto-update,tarball 装法不是 git 仓库)。
  try { await sh(`HOMEBREW_NO_AUTO_UPDATE=1 ${BREW_PREFIX}/bin/brew --version`, { timeout: 60000 }); }
  catch {
    emit && emit({ phase: "install-docker", status: "error", message: "Homebrew 解压完成但无法运行(点重试)" });
    return false;
  }
  emit && emit({ phase: "install-docker", status: "running", message: "Homebrew 安装完成 ✅" });
  return true;
}

async function ensureBrew({ emit } = {}) {
  if (await brewInstalled()) return true;
  if (await autoInstallBrew({ emit }) && (await brewInstalled())) return true;
  // 兜底:自动装没成,给手动指引(用户自己装好后点「重试」仍可继续)。
  emit && emit({ phase: "install-docker", status: "error",
    message: "Homebrew 自动安装未完成。可在「终端」手动安装后点「重试」:\n" +
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' });
  return false;
}

// brew install colima docker(幂等;已装则秒过)。docker 这个 formula 只是 CLI,
// Docker 引擎本体由 colima 在 VM 里提供。
async function installColima({ emit } = {}) {
  emit && emit({ phase: "install-docker", status: "running", message: "通过 Homebrew 安装 Colima 与 docker CLI(几分钟,下面是实时进度)…" });
  // HOMEBREW_NO_AUTO_UPDATE:tarball 装法不是 git 仓库,跳过隐式 auto-update(走 API 装 bottle)。
  await shStream("HOMEBREW_NO_AUTO_UPDATE=1 brew install colima docker 2>&1", { emit, phase: "install-docker", timeout: 1200000 });
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
  // 看到的就是没进度条)。续传 + 重试都在里头。
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
  const common = `--cpus ${VM_CPUS} --memory ${VM_MEMORY} --disk ${VM_DISK} ${diskArgs}`;
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

// 修复「为什么没用最新的 docker」: imagePresent() 只看本地有没有 `:latest` 标签,
// 旧镜像在就永远跳过下载 → 卡在过期镜像。这里改成校验 OSS tarball 的 ETag:本地缺镜像、
// 或 OSS 的 ETag 跟上次 load 的不一致 → 重下重载(删旧缓存包,避免同尺寸被误跳过)。
// 非破坏性:不删 VM、不删 volume(数据/token 不丢)。返回是否真的刷新了。
async function ensureFreshImage({ emit } = {}) {
  const e = (ev) => { try { emit && emit(ev); } catch {} };
  const present = await imagePresent();
  const remote = await docker.remoteImageEtag().catch(() => "");
  const loaded = docker.readLoadedImageEtag();
  // 本地有镜像、且能证明是最新(ETag 一致)→ 不动。HEAD 失败(remote 空)时不强刷,
  // 避免离线/被墙时把能用的旧镜像也拖垮。
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
//     entrypoint 找不到就试图全局 npm 重装 → EACCES 崩溃,:8008 起不来。named volume
//     首次挂载会**从镜像内容预填充**,容器才看得到预装的 cicy-code(和 WSL 一致)。
// 把宿主 ~/projects 挂进容器 /home/cicy/projects(~ 用 os.homedir() 展开,绝不写死)。
// Colima 把宿主 $HOME 挂进 VM,所以直接路径就能用(不像 WSL 要 /mnt 转换)。
// 源目录不存在先建出来,否则 docker 建挂载点会报错挡住容器启动。
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

function projectsMountArg() {
  try {
    const dir = path.join(os.homedir(), "projects");
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, "README.md");
    if (!fs.existsSync(readme)) { try { fs.writeFileSync(readme, PROJECTS_README); } catch {} }
    return `-v '${dir}':/home/cicy/projects`;
  } catch { return ""; }
}

async function runContainer({ port = 8008, container = "cicy-code-docker-8008", volume = "cicy-team-8008", env = {} } = {}) {
  if (await probeHealth(port)) return { adopted: true };
  try { await dk(`rm -f ${container}`, { timeout: 20000 }); } catch {} // 替换同名残留容器
  const envArgs = Object.entries(env || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `-e ${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  // 方案: Chrome 的 per-profile 代理(127.0.0.1:2000N)改由「宿主 mihomo」(host-mihomo.js)
  // 服务,不再从容器 publish 20001-32 —— colima/Lima 转发那个端口段始终到不了容器里只绑
  // 127.0.0.1 的监听(Chrome 一直 ERR_EMPTY_RESPONSE)。容器只暴露 cicy-code 的 :8008。
  const mk = (s) => `run -d --name ${container} --restart unless-stopped ${PLATFORM_FLAG} ` +
    `-p 127.0.0.1:${port}:8008 -p 127.0.0.1:${EXTRA_PORTS}:${EXTRA_PORTS} ` +
    `-e CICY_PUBLIC=1 -v ${volume}:/home/cicy ${s} ${envArgs} ${IMAGE}`;
  const mounts = projectsMountArg();
  try {
    await dk(mk(mounts), { timeout: 90000 });
  } catch (e) {
    if (!mounts) throw e;
    // 兜底: 带挂载启动失败(如 colima 访问挂载源出错)→ 去掉附加挂载重试,保证容器
    // 一定能起(projects 只是附加共享目录,不该挡住整个服务). '容器起不来' 的修复.
    console.warn(`[colima] 带挂载启动失败,去掉附加挂载重试: ${e.message}`);
    try { await dk(`rm -f ${container}`, { timeout: 20000 }); } catch {}
    await dk(mk(""), { timeout: 90000 });
  }
  return { started: true };
}

// 读容器自己的 api_token —— :port 唯一正确的凭证(宿主 8008 的 token 不通用)。
// named volume 的数据在 VM 内,读两条路(都真机实测过):① colima ssh 直读 VM 里
// 该卷的 _data/cicy-ai/global.json(最稳,避开 busy 容器的慢 exec);② 退回 docker
// exec。重试到 entrypoint 把 global.json 写出来为止;真读不到返回 ""(调用方不得拿
// 错/宿主 token 去开,会卡登录)。
async function readContainerToken(port = 8008, container = "cicy-code-docker-8008", volume = "cicy-team-8008") {
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

// Undo ensureAutostart. macOS moved from Colima to native cicy-code (colima
// crushed memory on 16G Macs), but builds upgraded from the old Colima era still
// carry the login LaunchAgent, which starts an unused `cicy-code` VM every boot.
// Called once on darwin startup to tear that leftover down. Gated on the plist
// actually existing so fresh/native-only installs never invoke colima at all.
async function removeAutostart() {
  if (process.platform !== "darwin") return;
  try {
    const label = `com.cicy.colima.${PROFILE}`;
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    if (!fs.existsSync(plist)) return; // no leftover → don't touch colima
    try { await sh(`launchctl unload ${JSON.stringify(plist)} 2>/dev/null; true`, { timeout: 15000 }); } catch {}
    try { fs.rmSync(plist, { force: true }); } catch {}
    // Stop ONLY our profile's VM (never the user's default colima). Keep the VM
    // image (no delete) so a rollback to a Colima build can restart it.
    try { await sh(`export PATH=${BREW_PATHS}:$PATH; colima stop -p ${PROFILE} 2>/dev/null; true`, { timeout: 60000 }); } catch {}
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
async function status(port = 8008) {
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

async function _bootstrap({ onProgress, port = 8008, container = "cicy-code-docker-8008", volume = "cicy-team-8008", env = {} } = {}) {
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

  // 4) 镜像(docker load R2 包)—— 缺镜像就下,镜像在但 OSS 有更新版也刷新(别卡旧镜像)
  try { await ensureFreshImage({ emit }); }
  catch (e) {
    if (!(await imagePresent())) { emit({ phase: "image", status: "error", message: `镜像下载失败:${e.message}(点重试续传)` }); return { ok: false, reason: "image_download_failed" }; }
    emit({ phase: "image", status: "running", message: `镜像刷新失败(${e.message}),沿用现有镜像` });
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
async function restart({ container = "cicy-code-docker-8008", port = 8008, volume = "cicy-team-8008" } = {}) {
  await startVM({});
  try { await dk(`exec ${container} supervisorctl -c /etc/supervisor/supervisord.conf restart cicy-code`, { timeout: 30000 }); }
  catch { try { await dk(`restart ${container}`, { timeout: 60000 }); } catch {} }
  const ok = await docker.waitUntil(() => probeHealth(port), { totalMs: 60000, everyMs: 2000 });
  if (ok) await ensureDesktopShortcut(volume, port);
  return ok;
}

// 原地更新 cicy-code(镜像内的 cicy-code-update.sh,不重建容器)。
async function update({ onProgress, container = "cicy-code-docker-8008", port = 8008 } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  await startVM({});
  emit({ phase: "image", status: "running", message: "更新 cicy-code(拉取最新版)…" });
  try {
    await shStream(`docker --context ${CTX} exec ${container} bash -lc "command -v cicy-code-update.sh >/dev/null && cicy-code-update.sh || /usr/local/bin/cicy-code-update.sh"`,
      { emit, phase: "image", timeout: 300000 });
  } catch (e) { emit({ phase: "done", status: "error", message: `更新失败:${e.message}(试试「升级」重装)` }); return { ok: false, reason: "update_failed" }; }
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? "cicy-code 已更新到最新 🎉" : "更新了但 :8008 还没响应——稍等或点重试" });
  return { ok: healthy };
}

async function stop({ container = "cicy-code-docker-8008" } = {}) {
  try { await dk(`stop ${container}`, { timeout: 30000 }); } catch {}
}

// docker restart 整个容器(entrypoint 重跑、重读 volume global.json)。
async function dockerRestart({ container = "cicy-code-docker-8008" } = {}) {
  await dk(`restart ${container}`, { timeout: 45000 });
  return true;
}

// 重建:强删占该端口的任何容器 + 目标容器,再 docker run(用新 env,如新 docker team
// 网关 key)。保留 bind-mount 宿主目录(数据/api_token 不丢)。破坏性 → 调用方要 confirm。
async function recreate({ onProgress, port = 8008, container = "cicy-code-docker-8008", volume = "cicy-team-8008", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  // 重建 = 用最新镜像重建。OSS 有更新版先刷新(非破坏性,不删 VM/volume),再 rm + run。
  try { await ensureFreshImage({ emit }); } catch (e) { emit({ phase: "image", status: "running", message: `镜像刷新跳过(${e.message}),用现有镜像重建` }); }
  try { await dk(`ps -aq --filter publish=${port} | xargs -r docker --context ${CTX} rm -f 2>/dev/null; docker --context ${CTX} rm -f ${container} 2>/dev/null; true`, { timeout: 30000 }); } catch {}
  const r = await runContainer({ port, container, volume, env });
  try { await ensureDesktopShortcut(volume, port); } catch {}
  return r;
}

// 升级 = 删 VM 重装(重置;cicy-team 数据随之重置,实例重新 seed 出新 token)。
async function upgrade({ onProgress, port = 8008, container = "cicy-code-docker-8008", volume = "cicy-team-8008", env = {} } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  emit({ phase: "install-docker", status: "running", message: "升级 = 重装运行环境(会重置容器数据)…" });
  try { await sh(`colima delete -f -p ${PROFILE} 2>/dev/null; true`, { timeout: 120000 }); } catch {}
  return await _bootstrap({ onProgress, port, container, volume, env });
}

// 容器里有没有注入网关 key(reconcile 自愈用):printenv 看 CICY_AI_GATEWAY_LLM_API_KEY。
async function hasGatewayKey(container = "cicy-code-docker-8008") {
  try { const { stdout } = await dk(`exec ${container} printenv CICY_AI_GATEWAY_LLM_API_KEY`, { timeout: 8000 }); return /sk-/.test(String(stdout || "")); }
  catch { return false; }
}

// 「授权容器访问 Mac」(不挂 docker):colima 自带 host.docker.internal 指向 Mac 主机,Mac
// sshd 已在 :22。把容器公钥写进 Mac 的 ~/.ssh/authorized_keys(容器没 key 就先 ssh-keygen),
// 并在容器里写 ~/.ssh/config 加 `mac` 别名(→ host.docker.internal)→ 容器内 `ssh mac` 即可
// 上 Mac 主机跑命令。Electron 主进程就以 Mac 用户跑,直接 fs 写 authorized_keys;容器侧走
// docker exec。比挂 docker.sock 更通用,且不碰 socket 的 GID 权限那摊事。
async function authorizeHostSsh({ container = "cicy-code-docker-8008" } = {}) {
  const user = os.userInfo().username; // Electron 跑在哪个 Mac 用户下 → 容器要 ssh 的目标用户
  // 1) 容器里确保有 keypair(都没有就生成 ed25519)
  await dk(`exec ${container} sh -c 'mkdir -p $HOME/.ssh && chmod 700 $HOME/.ssh; { [ -f $HOME/.ssh/id_ed25519 ] || [ -f $HOME/.ssh/id_rsa ]; } || ssh-keygen -t ed25519 -N "" -f $HOME/.ssh/id_ed25519 -q'`, { timeout: 30000 });
  // 2) 读容器公钥(ed25519 + rsa 都收)
  const { stdout } = await dk(`exec ${container} sh -c 'cat $HOME/.ssh/id_ed25519.pub $HOME/.ssh/id_rsa.pub 2>/dev/null'`, { timeout: 15000 });
  const pubs = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!pubs.length) throw new Error("容器公钥读取失败");
  // 3) 写进 Mac 主机 ~/.ssh/authorized_keys(去重)。主进程就是 Mac 用户,直接 fs。
  const sshDir = path.join(os.homedir(), ".ssh");
  fs.mkdirSync(sshDir, { recursive: true }); try { fs.chmodSync(sshDir, 0o700); } catch {}
  const ak = path.join(sshDir, "authorized_keys");
  let cur = ""; try { cur = fs.readFileSync(ak, "utf8"); } catch {}
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = pubs.filter((k) => !have.has(k));
  if (add.length) fs.appendFileSync(ak, (cur && !cur.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n");
  try { fs.chmodSync(ak, 0o600); } catch {}
  // 4) 容器里写 ~/.ssh/config 加 `mac` 别名(base64 传,免三层嵌套引号)
  const cfg = `Host mac\n  HostName host.docker.internal\n  User ${user}\n  StrictHostKeyChecking accept-new\n  ConnectTimeout 10\n`;
  const b64 = Buffer.from(cfg).toString("base64");
  await dk(`exec ${container} sh -c 'echo ${b64} | base64 -d > $HOME/.ssh/config && chmod 600 $HOME/.ssh/config'`, { timeout: 15000 });
  // 5) 端到端验证:容器内 ssh mac 跑一条
  let verified = false, detail = "";
  try {
    const v = await dk(`exec ${container} ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 mac 'echo CICY_SSH_OK; hostname'`, { timeout: 25000 });
    detail = String(v.stdout || "").trim();
    verified = /CICY_SSH_OK/.test(detail);
  } catch (e) { detail = String(e.stderr || e.stdout || e.message || "").trim().slice(-200); }
  return { ok: true, user, added: add.length, verified, detail };
}

// 读容器里 cicy-code 生成的 mihomo.yaml —— host-mihomo 用它在宿主重建 Chrome 代理配置
// (含云端下发的真实上游节点)。
async function readMihomoConfig(container = "cicy-code-docker-8008") {
  const { stdout } = await dk(`exec ${container} cat /home/cicy/cicy-ai/db/mihomo.yaml`, { timeout: 15000 });
  return String(stdout || "");
}

module.exports = {
  bootstrap, status, restart, stop, dockerRestart, recreate, update, upgrade, runContainer, readContainerToken,
  vmExists, colimaInstalled, dockerCliInstalled, engineUp, imagePresent, probeHealth, hasGatewayKey, authorizeHostSsh,
  readMihomoConfig, removeAutostart,
};
