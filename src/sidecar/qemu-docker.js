// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Docker-版 cicy-code on Windows via QEMU (不靠 WSL) —— 新机器的后端(老 WSL 机器不动,见 linux-backend.js)。
//
// 跑在首页「Debian」卡片的同一台 QEMU 虚拟机里(只开一台,不各占一份内存):
//   • 虚拟机的生命周期(下载 QEMU/Debian 镜像、开机、关机、端口转发)全交给 qemu-vm.cjs ——
//     首页和这里共用同一份源码、同一套磁盘约定(~/cicy-ai/vm/debian),谁先开机谁当 runner;
//   • 虚拟机里的事(装 Docker、docker load/run/exec、读 token)走 SSH(ssh2,密钥由 qemu-vm.cjs
//     生成并经 cloud-init 注入),每条命令 `sudo -n sh -c`,等价于 wsl-docker.js 的 wslRun;
//   • 端口:宿主 127.0.0.1:<port> 经 QMP hostfwd_add 转发到虚拟机 :<port>,容器 -p <port>:8008。
//     虚拟机网卡只有 slirp,外面只够得着宿主回环,所以虚拟机内 0.0.0.0 发布是安全的。
//
// 与 wsl-docker.js / colima-docker.js 同接口(bootstrap/status/restart/stop/dockerRestart/
// recreate/update/upgrade/runContainer/readContainerToken/…),sidecar-ipc 经 app-docker.js 选用。
// WSL 专属的自愈(repairWsl / wslShutdown / elevatedTcpRepair)这里没有 —— sidecar-ipc 对它们
// 都是 `appDocker.x &&` 判空调用,缺了就自然跳过。
//
// 已知差异:没有宿主目录共享(Windows 上的 QEMU 不支持 virtio-9p/virtiofs),所以不挂 C:\projects
// 和各盘;容器数据在虚拟机磁盘的 docker 卷里。软件模拟(无 WHPX)能跑但很慢,会在进度里提示。

const { spawn, execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const https = require("https");
const log = require("electron-log");
const docker = require("./docker"); // 共享:downloadImageTarball / remoteImageEtag / waitUntil / probeHealth
const { gatewayKeyPresentInEnv } = require("./gateway-key-health");
const { t } = require("../i18n");
const { shouldSkipCicyUpdate } = require("./cicy-runtime-health");
const { inAppUpdate } = require("./cicy-inapp-update");
const protect = require("./docker-protect");

const IMAGE = process.env.CICY_DOCKER_IMAGE || "cicybot/cicy-code:latest";
const VM_DIR = path.join(os.homedir(), "cicy-ai", "vm", "debian");
const CTL_SRC = path.join(__dirname, "qemu-vm.cjs");
const CTL_DST = path.join(os.homedir(), "cicy-ai", "db", "qemu-vm-ctl.js");
const SSH_PORT = 17622;
const CICY_NODE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "cicy-node", "node.exe");

// ---- qemu-vm.cjs(虚拟机控制)--------------------------------------------

// 用哪个 node 跑控制脚本:优先 dsh 同款便携 node(%LOCALAPPDATA%\cicy-node);没有就用 Electron
// 自己当 node(ELECTRON_RUN_AS_NODE)。前者更好:后台 runner 进程不叫「CiCy Desktop.exe」,
// desktop 退出/升级杀进程时不会把虚拟机一起带走。
function ctlNode() {
  if (fs.existsSync(CICY_NODE)) return { bin: CICY_NODE, env: { ...process.env } };
  return { bin: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}
function writeCtl() {
  const src = fs.readFileSync(CTL_SRC, "utf8");
  let cur = ""; try { cur = fs.readFileSync(CTL_DST, "utf8"); } catch {}
  if (cur !== src) { fs.mkdirSync(path.dirname(CTL_DST), { recursive: true }); fs.writeFileSync(CTL_DST, src); }
}
function ctl(op, args = [], timeout = 90000) {
  return new Promise((resolve) => {
    try { writeCtl(); } catch (e) { return resolve({ ok: false, error: "ctl_write_failed", detail: e.message }); }
    const { bin, env } = ctlNode();
    execFile(bin, [CTL_DST, op, ...args.map(String)], { windowsHide: true, timeout, env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const m = String(stdout || "").trim().match(/\{[\s\S]*\}$/);
      if (m) { try { return resolve(JSON.parse(m[0])); } catch {} }
      resolve({ ok: false, error: "ctl_no_output", detail: String(stderr || (err && err.message) || "").trim().slice(-400) });
    });
  });
}
const vmStatus = () => ctl("status", [], 30000);

// ---- SSH(进虚拟机跑命令)-------------------------------------------------

function shQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
let _conn = null, _connP = null;
function sshConnect() {
  if (_conn) return Promise.resolve(_conn);
  if (_connP) return _connP;
  _connP = new Promise((resolve, reject) => {
    let key;
    try { key = fs.readFileSync(path.join(VM_DIR, "id_rsa")); } catch (e) { _connP = null; return reject(Object.assign(new Error("no_ssh_key"), { code: "no_ssh_key" })); }
    const { Client } = require("ssh2");
    const c = new Client();
    const done = (err) => { _connP = null; if (err) { try { c.end(); } catch {} reject(err); } else { _conn = c; resolve(c); } };
    c.on("ready", () => done());
    c.on("error", (e) => { if (_conn === c) _conn = null; done(e); });
    c.on("close", () => { if (_conn === c) _conn = null; });
    c.connect({ host: "127.0.0.1", port: SSH_PORT, username: "cicy", privateKey: key, readyTimeout: 15000, keepaliveInterval: 15000 });
  });
  return _connP;
}
// 等价于 wslRun:成功 resolve {stdout, stderr};非零退出 reject(err.stdout/err.stderr/err.code)。
// opts.stdin:可读流,灌进命令的 stdin(docker load 用)。opts.onLine:逐行回调(流式进度)。
async function vmRun(cmd, { timeout = 60000, stdin, onLine } = {}) {
  const c = await sshConnect();
  return new Promise((resolve, reject) => {
    c.exec(`sudo -n sh -c ${shQuote(cmd)}`, (err, stream) => {
      if (err) { _conn = null; try { c.end(); } catch {} return reject(err); }
      let out = "", errOut = "", buf = "";
      const timer = setTimeout(() => { try { stream.close(); } catch {} reject(Object.assign(new Error(`vmRun timeout after ${timeout}ms: ${cmd.slice(0, 120)}`), { stdout: out, stderr: errOut })); }, timeout);
      const line = (chunk) => {
        if (!onLine) return;
        buf += chunk;
        let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).replace(/\r$/, "").trim(); buf = buf.slice(i + 1); if (l) { try { onLine(l); } catch {} } }
      };
      stream.on("data", (d) => { const s = d.toString("utf8"); out += s; line(s); });
      stream.stderr.on("data", (d) => { const s = d.toString("utf8"); errOut += s; line(s); });
      stream.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout: out, stderr: errOut });
        else reject(Object.assign(new Error(`exit ${code}: ${(errOut || out).trim().slice(-300)}`), { code, stdout: out, stderr: errOut }));
      });
      if (stdin) { stdin.on("error", (e) => { try { stream.close(); } catch {} reject(e); }); stdin.pipe(stream); }
      else stream.end();
    });
  });
}
function vmRunStream(cmd, { emit, phase = "install-docker", timeout = 900000 } = {}) {
  let last = 0;
  return vmRun(cmd, { timeout, onLine: (l) => { const now = Date.now(); if (emit && now - last > 350) { last = now; emit({ phase, status: "running", message: l.slice(0, 200) }); } } });
}
async function sshOk() { try { await vmRun("true", { timeout: 15000 }); return true; } catch (e) { _conn = null; return false; } }

// ---- 虚拟机就绪 ----------------------------------------------------------

const vmInstalled = (s) => !!(s && s.installed);

// 装(如需)→ 开机(如需)→ 等 SSH 可用。已装好的旧虚拟机(首页先装的,没注入 desktop 公钥)
// 需要按新 instance-id 重开机一次,让 cloud-init 把公钥写进去。
async function ensureVm({ emit } = {}) {
  const e = (ev) => { try { emit && emit(ev); } catch {} };
  let s = await vmStatus();
  if (!s.ok) return { ok: false, reason: "vm_ctl_failed", message: [s.error, s.detail].filter(Boolean).join(": ") };
  if (!vmInstalled(s)) {
    e({ phase: "install-docker", status: "running", message: "下载 QEMU 便携版 + Debian 13 云镜像(约 390MB,不需要 WSL)…" });
    const r = await ctl("install");
    if (!r.ok) return { ok: false, reason: "vm_install_failed", message: r.error };
    let lastPhase = "";
    for (;;) {
      await new Promise((res) => setTimeout(res, 2000));
      s = await vmStatus();
      if (s.installed && !s.installing) break;
      if (!s.installing) return { ok: false, reason: "vm_install_failed", message: s.installError || "stopped" };
      if (s.phase !== lastPhase) { lastPhase = s.phase; e({ phase: "install-docker", status: "running", message: `虚拟机安装:${s.phase}` }); }
      if (s.total && (s.phase === "qemu" || s.phase === "image")) {
        e({ phase: s.phase === "qemu" ? "install-docker" : "image", status: "running", progress: Math.min(99, Math.round(s.bytes * 100 / s.total)), received: s.bytes, total: s.total, url: s.src, label: s.phase === "qemu" ? "QEMU" : "Debian 13" });
      }
    }
    e({ phase: "install-docker", status: "done", message: "QEMU + Debian 13 就绪" });
  }
  let restarted = false;
  for (let round = 0; round < 2; round++) {
    s = await vmStatus();
    if (!s.running) {
      e({ phase: "install-docker", status: "running", message: "启动 Debian 虚拟机…" });
      const r = await ctl("start");
      if (!r.ok) return { ok: false, reason: "vm_start_failed", message: [r.error, r.detail, r.tail].filter(Boolean).join(" · ").slice(0, 400) };
    }
    const t0 = Date.now();
    const up = await docker.waitUntil(sshOk, { totalMs: 15 * 60 * 1000, everyMs: 5000, onTick: () => e({ phase: "install-docker", status: "running", message: `等虚拟机开机…(${Math.round((Date.now() - t0) / 1000)}s)` }) });
    if (up) {
      s = await vmStatus();
      if (s.accel === "tcg") e({ phase: "install-docker", status: "running", message: "⚠️ 这台机器没开 WHPX,虚拟机在软件模拟下运行,Docker 版 cicy-code 会很慢。首页「本机团队」卡片 ⋯ 菜单里可「开启硬件加速」(需管理员 + 重启)。" });
      return { ok: true, accel: s.accel };
    }
    // SSH 一直不通:多半是这台虚拟机是首页早先开的(老 provision,没 desktop 公钥)→ 重开机一次。
    if (restarted) break;
    restarted = true;
    log.warn(`[qemu-docker] ssh not reachable (provision=${s.provision}) → reboot VM once to re-run cloud-init`);
    e({ phase: "install-docker", status: "running", message: "虚拟机需要按新配置重开机一次(注入 desktop 的 SSH 密钥)…" });
    await ctl("stop", [], 120000);
  }
  return { ok: false, reason: "vm_ssh_unreachable", message: "虚拟机开机了但 SSH 一直连不上(看 ~/cicy-ai/logs/debian-console.log)" };
}

// 宿主 127.0.0.1:<p> → 虚拟机 :<p>。转发开机才有效、关机即丢,所以每次用之前都补一遍(重复添加
// 无害)。runContainer 用过的端口记在 forwards.json,之后只传主端口也能把额外端口一并补回来。
const FWD_FILE = path.join(VM_DIR, "forwards.json");
function savedForwards() { try { return (JSON.parse(fs.readFileSync(FWD_FILE, "utf8")).ports || []).map(Number); } catch { return []; } }
async function ensureForwards(port, extraPorts = [], { save = false } = {}) {
  const want = [port, ...(Array.isArray(extraPorts) ? extraPorts : [])].map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (save) { try { fs.writeFileSync(FWD_FILE, JSON.stringify({ ports: [...new Set(want)] })); } catch {} }
  const ports = [...new Set([...want, ...savedForwards()])];
  const r = await ctl("fwd", ports, 20000);
  if (!r.ok) log.warn(`[qemu-docker] hostfwd ${ports.join(",")} failed: ${r.error}`);
  return r;
}

// ---- Docker 引擎 ---------------------------------------------------------

async function dockerInstalled() { try { await vmRun("command -v docker >/dev/null", { timeout: 15000 }); return true; } catch { return false; } }
async function dockerEngineUp() { try { await vmRun("docker info >/dev/null 2>&1", { timeout: 20000 }); return true; } catch { return false; } }

// apt 装 docker.io(Debian 自带包)。deb.debian.org 在 CN 很慢 → 5 秒探不通就换 TUNA。
async function installDockerEngine({ emit } = {}) {
  emit && emit({ phase: "install-docker", status: "running", message: "在虚拟机里安装 Docker 引擎(apt install docker.io)…" });
  const mirror = "if ! curl -fsS -m 5 -o /dev/null https://deb.debian.org/debian/dists/trixie/Release; then " +
    "sed -i 's#http[s]*://deb.debian.org#https://mirrors.tuna.tsinghua.edu.cn#g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; fi";
  await vmRunStream(`${mirror}; export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -y -q docker.io && systemctl enable --now docker && usermod -aG docker cicy`, { emit, phase: "install-docker", timeout: 1800000 });
}

// ---- 镜像 ----------------------------------------------------------------

async function imagePresent() { try { await vmRun(`docker image inspect ${IMAGE} >/dev/null 2>&1`, { timeout: 15000 }); return true; } catch { return false; } }
// 宿主下好的 R2 tarball 经 SSH stdin 先落成虚拟机里的临时文件,再 `docker load -i`(不需要共享目录;
// 落盘后 load 失败也能和传输失败分开)。
// ⚠️ 读流挂了统计进度的 'data' 监听就会立刻开始流动,而 SSH 通道是异步建起来的 —— 不先 pause(),
// 管道接上之前的那段数据就被白白读掉,虚拟机收到的包缺头 → docker load 报 invalid tar header(实测)。
async function loadImage(tarball, { emit } = {}) {
  const total = (() => { try { return fs.statSync(tarball).size; } catch { return 0; } })();
  let sent = 0, lastPct = -1;
  const rs = fs.createReadStream(tarball);
  rs.on("data", (chunk) => {
    sent += chunk.length;
    const pct = total ? Math.floor((sent / total) * 100) : -1;
    if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; emit && emit({ phase: "image", status: "loading", message: `导入镜像到虚拟机 Docker… ${pct}%`, progress: pct }); }
  });
  rs.pause();   // 等 vmRun 里 pipe() 接上再流(见上)
  const tmp = "/var/tmp/cicy-image.tar.gz";
  await vmRun(`cat > ${tmp}`, { stdin: rs, timeout: 1800000 });
  emit && emit({ phase: "image", status: "loading", message: "镜像已传进虚拟机,docker load 中(约 1 分钟)…" });
  let stdout = "";
  try { ({ stdout } = await vmRun(`docker load -i ${tmp}`, { timeout: 1800000 })); }
  finally { try { await vmRun(`rm -f ${tmp}`, { timeout: 30000 }); } catch {} }
  const m = String(stdout).match(/Loaded image:\s*(\S+)/i);
  if (m && m[1] !== IMAGE) { try { await vmRun(`docker tag ${m[1]} ${IMAGE}`, { timeout: 15000 }); } catch {} }
}
// 同 wsl/colima:缺镜像、或 R2 tarball 的 ETag 跟上次 load 的不一致 → 重下重载(非破坏性)。
async function ensureFreshImage({ emit } = {}) {
  const e = (ev) => { try { emit && emit(ev); } catch {} };
  const present = await imagePresent();
  const remote = await docker.remoteImageEtag().catch(() => "");
  const loaded = docker.readLoadedImageEtag();
  if (present && remote && loaded && remote === loaded) return false;
  if (present && !remote) return false;
  if (present && remote !== loaded) { e({ phase: "image", status: "running", message: "检测到更新的镜像,正在拉取最新版…" }); docker.clearImageTarball(); }
  let tarball;
  try { tarball = await docker.downloadImageTarball({ emit }); }
  catch (err) { if (present) { e({ phase: "image", status: "running", message: `最新镜像下载失败(${err.message}),沿用现有镜像` }); return false; } throw err; }
  await loadImage(tarball, { emit });
  if (remote) docker.writeLoadedImageEtag(remote);
  return true;
}

// ---- 容器 ----------------------------------------------------------------

const probeHealth = docker.probeHealth;

async function containerState(container) {
  try { const { stdout } = await vmRun(`docker inspect --format '{{.State.Status}}' ${container} 2>/dev/null`, { timeout: 15000 }); return String(stdout || "").trim() || null; }
  catch { return null; }
}
function publishArgs(port, extraPorts = []) {
  const seen = new Set([Number(port), 8008]);
  let args = `-p ${port}:8008`;
  for (const raw of Array.isArray(extraPorts) ? extraPorts : []) {
    const p = Number(raw);
    if (!Number.isInteger(p) || p < 1 || p > 65535 || seen.has(p)) continue;
    seen.add(p); args += ` -p ${p}:${p}`;
  }
  return args;
}
// DooD:把虚拟机里 dockerd 的 socket 和 docker 客户端挂进容器(兄弟容器,同 wsl 版)。
async function dockerSockMountArg() {
  const SOCK = "/var/run/docker.sock";
  try { await vmRun(`test -S ${SOCK}`, { timeout: 10000 }); } catch { return ""; }
  let groupAdd = "", cliMount = "";
  try { const gid = String((await vmRun(`stat -c '%g' ${SOCK}`, { timeout: 10000 })).stdout || "").trim(); if (/^\d+$/.test(gid)) groupAdd = ` --group-add ${gid}`; } catch {}
  try { const p = String((await vmRun("command -v docker", { timeout: 10000 })).stdout || "").trim(); if (p) cliMount = ` -v ${p}:/usr/local/bin/docker:ro`; } catch {}
  return `-v ${SOCK}:${SOCK}${cliMount}${groupAdd}`;
}

async function startExisting({ container, port, emit } = {}) {
  if (await probeHealth(port)) return { ok: true, adopted: true };
  const v = await ensureVm({ emit });
  if (!v.ok) return { ok: false, error: v.message };
  await ensureForwards(port);
  const st = await containerState(container);
  if (!st) return { ok: false, missing: true };
  if (st !== "running") { try { await vmRun(`docker start ${container}`, { timeout: 60000 }); } catch (e) { return { ok: false, error: e.message }; } }
  const ok = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  return { ok, container };
}

async function runContainer({ port, container, volume, env = {}, extraPorts = [], dockerSock = false, emit, force = false } = {}) {
  await ensureForwards(port, extraPorts, { save: true });
  if (await probeHealth(port)) return { adopted: true };
  const existing = await containerState(container);
  if (existing && !protect.guard(log, `docker rm -f ${container} (state=${existing})`, { force })) {
    emit && emit({ phase: "container", status: "running", message: `容器已存在(${existing}),受保护 → 仅 docker start` });
    try { await vmRun(`docker start ${container}`, { timeout: 60000 }); } catch (e) { log.warn(`[qemu-docker] docker start failed: ${e.message}`); }
    return { started: true, reused: true };
  }
  try { await vmRun(`docker rm -f ${container}`, { timeout: 30000 }); } catch {}
  const inherited = {};
  for (const key of ["CICY_CLOUD_EMAIL", "CICY_CLOUD_TEAM_ID", "CICY_CFT"]) if (process.env[key]) inherited[key] = process.env[key];
  const envArgs = Object.entries({ ...inherited, ...(env || {}) })
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `-e ${k}=${shQuote(v)}`).join(" ");
  let doodOn = dockerSock;
  if (!doodOn) { try { doodOn = require("./cicy-code").isDood(); } catch {} }
  const sockArg = doodOn ? await dockerSockMountArg() : "";
  const cmd = `docker run -d --name ${container} --restart unless-stopped --dns 223.5.5.5 --dns 8.8.8.8 ${publishArgs(port, extraPorts)} -e CICY_PUBLIC=1 -v ${volume}:/home/cicy ${sockArg} ${envArgs} ${IMAGE}`;
  emit && emit({ phase: "container", status: "running", message: `$ ${cmd.length > 220 ? cmd.slice(0, 220) + " …" : cmd}` });
  await vmRun(cmd, { timeout: 120000 });
  return { started: true };
}

// 容器自己的 api_token(卷里的 global.json)—— :port 唯一正确的凭证。失败 60s 内不再重试(同 wsl 版)。
let _tokenFailAt = 0;
async function readContainerToken(port, container, volume, { onLog } = {}) {
  const say = (status, message) => { try { (status === "error" ? log.warn : log.info)(`[qemu-docker:token] ${message}`); } catch {} try { onLog && onLog({ status, message }); } catch {} };
  if (Date.now() - _tokenFailAt < 60000) return "";
  port = Number(port || process.env.CICY_DOCKER_APP_PORT || 8009);
  const vol = volume || `cicy-team-${port}`;
  container = container || `cicy-code-docker-${port}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { stdout } = await vmRun(`cat /var/lib/docker/volumes/${vol}/_data/cicy-ai/global.json 2>/dev/null`, { timeout: 10000 });
      const m = String(stdout).match(/"api_token"\s*:\s*"(cicy_[A-Za-z0-9]+)"/);
      if (m) { say("done", t("dockerOpen.tokVolHit", { n: attempt })); return m[1]; }
      say("running", t("dockerOpen.tokVolMiss"));
    } catch (e) { say("running", t("dockerOpen.tokVolErr", { err: e.message })); }
    if (container) {
      try {
        const { stdout } = await vmRun(`docker exec ${container} cat /home/cicy/cicy-ai/global.json`, { timeout: 12000 });
        const tok = JSON.parse(stdout).api_token || "";
        if (tok) { say("done", t("dockerOpen.tokExecHit", { n: attempt })); return tok; }
      } catch (e) { say("running", t("dockerOpen.tokExecErr", { err: e.message })); }
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 2000));
  }
  say("error", t("dockerOpen.tokFail"));
  _tokenFailAt = Date.now();
  return "";
}

async function insideHealthy(container, port) {
  try { await vmRun(`docker exec ${container} node -e "fetch('http://127.0.0.1:8008/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`, { timeout: 20000 }); return true; }
  catch { return false; }
}

// ---- 状态 / bootstrap ----------------------------------------------------

// 与 wsl status 同形:wsl → 虚拟机已装(QEMU+镜像在),distro → 同,engineUp → 虚拟机里 dockerd 在。
// 不碰 SSH 就能答的先答:没装 / 没开机直接返回,不阻塞。
async function status(port) {
  const healthy = await probeHealth(port);
  const s = await vmStatus();
  if (!s.ok) return { wsl: false, distro: false, engineUp: false, running: healthy, healthy, unknown: !healthy };
  const installed = vmInstalled(s);
  const engineUp = !!(s.running && installed && (await dockerEngineUp()));
  return { wsl: installed, distro: installed, engineUp, running: healthy, healthy, accel: s.accel || "", vmRunning: !!s.running };
}

let _bootstrapInFlight = null;
async function bootstrap(opts = {}) {
  if (_bootstrapInFlight) {
    try { opts.onProgress && opts.onProgress({ phase: "install-docker", status: "running", message: "安装已在进行中,正在跟随同一进度…" }); } catch {}
    return _bootstrapInFlight;
  }
  _bootstrapInFlight = _bootstrap(opts).finally(() => { _bootstrapInFlight = null; });
  return _bootstrapInFlight;
}

async function _bootstrap({ onProgress, port, container, volume, env = {}, extraPorts = [], dockerSock = false } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  const T0 = Date.now();
  const fail = (reason, message) => {
    log.error(`[qemu-docker] bootstrap ✗ ${reason} ${((Date.now() - T0) / 1000).toFixed(1)}s ${message || ""}`);
    emit({ phase: reason.startsWith("image") ? "image" : reason.startsWith("vm") || reason.startsWith("docker_install") ? "install-docker" : "container", status: "error", message: `${message || reason}(点重试)` });
    return { ok: false, reason, message };
  };
  log.info(`[qemu-docker] bootstrap START port=${port} container=${container} volume=${volume}`);
  if (await probeHealth(port)) { emit({ phase: "done", status: "done", message: "Docker cicy-code 已就绪 🎉" }); return { ok: true, container }; }

  const v = await ensureVm({ emit });
  if (!v.ok) return fail(v.reason, v.message);

  if (!(await dockerInstalled())) {
    try { await installDockerEngine({ emit }); } catch (e) { return fail("docker_install_failed", `Docker 安装失败:${e.message}`); }
  }
  if (!(await dockerEngineUp())) {
    try { await vmRun("systemctl start docker", { timeout: 60000 }); } catch {}
    if (!(await docker.waitUntil(dockerEngineUp, { totalMs: 90000, everyMs: 3000 }))) return fail("dockerd_not_up", "Docker 引擎没起来");
  }

  try { await ensureFreshImage({ emit }); }
  catch (e) {
    if (!(await imagePresent())) return fail("image_download_failed", `镜像下载失败:${e.message}`);
    emit({ phase: "image", status: "running", message: `镜像刷新失败(${e.message}),沿用现有镜像` });
  }

  emit({ phase: "container", status: "running", message: "启动 cicy-code 服务…" });
  try { await runContainer({ port, container, volume, env, extraPorts, dockerSock, emit }); }
  catch (e) { return fail("container_start_failed", `服务启动失败:${e.message}`); }

  emit({ phase: "container", status: "running", message: "等待 cicy-code 就绪…" });
  // 软件模拟下 cicy-code 冷启动可能要好几分钟
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: (v.accel === "tcg" ? 600 : 180) * 1000, everyMs: 3000 });
  if (!healthy) return fail("health_timeout", `服务起来了但 127.0.0.1:${port} 还没响应——稍等或点「重试」`);
  log.info(`[qemu-docker] bootstrap DONE ${((Date.now() - T0) / 1000).toFixed(1)}s accel=${v.accel}`);
  emit({ phase: "done", status: "done", message: "Docker cicy-code 已就绪 🎉" });
  return { ok: true, container };
}

// 守护循环在 :port 健康后调一次:确保端口转发还在(虚拟机重开机后转发会丢)。
// 虚拟机开机自启由首页 Debian 卡片和这里的 reconcile/bootstrap 负责,不另建计划任务。
async function ensureAutostart({ port, extraPorts } = {}) {
  const p = Number(port || process.env.CICY_DOCKER_APP_PORT || 8009);
  await ensureForwards(p, extraPorts || []);
}

// ---- 生命周期(卡片 ⋯ 菜单)--------------------------------------------

async function restart({ container, port } = {}) {
  await ensureVm({}); await ensureForwards(port);
  try { await vmRun(`docker exec ${container} supervisorctl -c /etc/supervisor/supervisord.conf restart cicy-code`, { timeout: 30000 }); }
  catch { try { await vmRun(`docker restart ${container}`, { timeout: 60000 }); } catch {} }
  return docker.waitUntil(() => probeHealth(port), { totalMs: 90000, everyMs: 2000 });
}
async function stop({ container } = {}) { try { await vmRun(`docker stop ${container}`, { timeout: 45000 }); } catch {} }
async function dockerRestart({ container } = {}) { await vmRun(`docker restart ${container}`, { timeout: 60000 }); return true; }

function getJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { "user-agent": "cicy-desktop" } }, (res) => {
      let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject);
  });
}
async function resolveLatestCicy(net) {
  const order = net === "global" ? ["https://registry.npmjs.org", "https://registry.npmmirror.com"] : ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
  for (const reg of order) { try { const j = await getJson(`${reg}/cicy-code/latest`, 12000); if (j && j.version) return String(j.version); } catch {} }
  return null;
}
async function installedCicyVersion(container) {
  try { const j = JSON.parse((await vmRun(`docker exec ${container} bash -lc "cat ~/cicy-ai/runtime/versions.json 2>/dev/null"`, { timeout: 15000 })).stdout); return j && j["cicy-code"] && j["cicy-code"].current ? String(j["cicy-code"].current) : null; }
  catch { return null; }
}

// 原地更新 cicy-code:先走 cicy-code 自己的 API(POST /api/cicy-update),不行再推 desktop 自带的
// cicy-code-update.sh 进容器跑(同 wsl 版,去掉了 WSL 专属的引擎自愈)。
async function update({ onProgress, container, port } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  await ensureVm({ emit }); await ensureForwards(port);
  emit({ phase: "image", status: "running", message: t("docker.updating.checking") });
  let net = "unknown"; try { net = await require("./net-detect").detect(); } catch {}
  const [latest, current] = await Promise.all([resolveLatestCicy(net), installedCicyVersion(container)]);
  if (shouldSkipCicyUpdate({ latest, current, platformReady: true })) {
    emit({ phase: "done", status: "done", message: t("docker.updating.alreadyLatest", { v: current }) });
    return { ok: true, alreadyLatest: true, version: current };
  }
  const registry = net === "global" ? "https://registry.npmjs.org" : net === "cn" ? "https://registry.npmmirror.com" : "";
  try {
    const token = await readContainerToken(port, container, `cicy-team-${port}`);
    const r = await inAppUpdate({ port, token, target: latest || "", registry, emit });
    if (r.started) {
      emit({ phase: "done", status: r.ok ? "done" : "error", message: r.ok ? t("docker.updating.doneVersion", { v: r.version }) : t("docker.updating.notReady") });
      return { ok: r.ok, version: r.version || latest || null, inApp: true };
    }
  } catch (e) { emit({ phase: "image", status: "running", message: `in-app update failed (${e.message}) → docker exec` }); }
  try {
    const b64 = Buffer.from(fs.readFileSync(path.join(__dirname, "container-scripts", "cicy-code-update.sh"), "utf8").replace(/\r\n?/g, "\n"), "utf8").toString("base64");
    await vmRun(`echo ${b64} | base64 -d | docker exec -u root -i ${container} bash -c 'cat > /usr/local/bin/cicy-code-update.sh && chmod 0755 /usr/local/bin/cicy-code-update.sh'`, { timeout: 30000 });
  } catch (e) { log.warn(`[qemu-docker] push cicy-code-update.sh failed: ${e.message}`); }
  const regEnv = registry ? `-e NPM_REGISTRY=${registry} ` : "";
  try { await vmRunStream(`docker exec ${regEnv}${container} bash -lc "/usr/local/bin/cicy-code-update.sh${latest ? " " + latest : ""}"`, { emit, phase: "image", timeout: 300000 }); }
  catch (e) { emit({ phase: "done", status: "error", message: t("docker.updating.failed", { msg: e.message }) }); return { ok: false, reason: "update_failed" }; }
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? t("docker.updating.doneLatest") : t("docker.updating.notReady") });
  return { ok: healthy, version: latest || null };
}

// 重建:最新镜像 + 新 env 重新 docker run(卷保留,数据/token 不丢)。保护开启且非用户显式 → 只确保在跑。
async function recreate({ onProgress, port, container, volume, env = {}, extraPorts = [], dockerSock = false, force = false } = {}) {
  const emit = (ev) => { try { onProgress && onProgress(ev); } catch {} };
  const v = await ensureVm({ emit });
  if (!v.ok) { emit({ phase: "done", status: "error", message: v.message }); return { ok: false, reason: v.reason }; }
  if (!protect.guard(log, `recreate ${container}`, { force })) {
    emit({ phase: "container", status: "running", message: "容器保护已开启:跳过重建,仅确保容器在运行" });
    const r = await startExisting({ container, port, emit });
    if (r.missing) { await runContainer({ port, container, volume, env, extraPorts, dockerSock, emit }); }
    const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 120000, everyMs: 3000 });
    emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? t("docker.ready") : t("docker.updating.notReady") });
    return { ok: healthy, blocked: true };
  }
  try { await ensureFreshImage({ emit }); } catch (e) { emit({ phase: "image", status: "running", message: `镜像刷新跳过(${e.message}),用现有镜像重建` }); }
  try { await vmRun(`docker ps -aq --filter publish=${port} | xargs -r docker rm -f; docker rm -f ${container}; true`, { timeout: 45000 }); } catch {}
  const r = await runContainer({ port, container, volume, env, extraPorts, dockerSock, emit, force: true });
  emit({ phase: "container", status: "running", message: t("docker.updating.starting") });
  const healthy = await docker.waitUntil(() => probeHealth(port), { totalMs: 180000, everyMs: 3000 });
  emit({ phase: "done", status: healthy ? "done" : "error", message: healthy ? t("docker.ready") : t("docker.updating.notReady") });
  return { ...r, ok: healthy };
}
// 「升级」:WSL 版是重装发行版;这里虚拟机和首页 Debian 共用,不能删 —— 等同于用最新镜像强制重建。
async function upgrade(opts = {}) { return recreate({ ...opts, force: true }); }

async function hasGatewayKey(container) {
  try { const { stdout } = await vmRun(`docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${container}`, { timeout: 12000 }); return gatewayKeyPresentInEnv(stdout); }
  catch (e) { log.warn(`[qemu-docker] hasGatewayKey check failed: ${e.message}`); return null; }
}
async function readMihomoConfig(container) {
  return String((await vmRun(`docker exec ${container} cat /home/cicy/cicy-ai/db/mihomo.yaml`, { timeout: 15000 })).stdout || "");
}
function parseMihomoSelections(payload) {
  let parsed; try { parsed = JSON.parse(String(payload || "")); } catch { throw new Error("invalid mihomo controller response"); }
  if (!parsed || !parsed.proxies || typeof parsed.proxies !== "object") throw new Error("invalid mihomo controller response: proxies missing");
  const out = {};
  for (const [name, p] of Object.entries(parsed.proxies)) if (p && p.type === "Selector" && typeof p.now === "string" && p.now) out[name] = p.now;
  return out;
}
async function readMihomoSelections(container) {
  return parseMihomoSelections((await vmRun(`docker exec ${container} curl -fsS http://127.0.0.1:19001/proxies`, { timeout: 15000 })).stdout);
}

module.exports = {
  backend: "qemu",
  bootstrap, status, restart, stop, dockerRestart, recreate, update, upgrade, runContainer, readContainerToken,
  insideHealthy, probeHealth, ensureAutostart, startExisting, containerState, hasGatewayKey,
  readMihomoConfig, readMihomoSelections, parseMihomoSelections,
  vmRun, ensureVm, ensureForwards, vmStatus, dockerEngineUp, imagePresent, loadImage,
};
