// Debian 虚拟机控制脚本 —— desktop 的 QEMU 版 Docker cicy-code 用(src/sidecar/qemu-docker.js 把它写到
// ~/cicy-ai/db/qemu-vm-ctl.js 再跑)。首页的「Debian 13」卡片曾经也用它(写成 debian-ctl.js),
// 2026-10-21 卡片已下线(和「Docker 团队」是同一台虚拟机,重复了);老首页写过的 debian-ctl.js 可能还在。
//   node <ctl> <status|install|start|stop|open|accel|fwd <port>...>
// 两边版本可能不同步,所以只认同一套磁盘约定(vmDir 下的文件 + 端口),谁先开机谁当 runner。
// 只打一行 JSON 到 stdout。不靠 WSL:QEMU 便携版 + Debian 官方云镜像,
// 有 WHPX(Windows 虚拟机监控程序平台)就用硬件加速,没有就退回纯软件模拟(TCG),
// 所以不要管理员也能开箱用;「开启加速」才需要一次管理员 + 重启。
// 后台活(install-run / run)一律用 Start-Process -WindowStyle Hidden 起 node:
// 这样后台 node 自己有一个被隐藏的控制台,它起的 curl / qemu-img / qemu 都继承它,
// 不会每个子进程各弹一个黑窗口(dsh 那次的教训)。
// 首页不发 desktop 版就能更新这里;改版本号/端口/源时同步改 DEB_* 常量。
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), net = require("net"), http = require("http"), crypto = require("crypto");
const OP = process.argv[2] || "status";

const QEMU_VER = "11.1.0";
const QEMU_ZIP = "cicy-qemu-" + QEMU_VER + "-win-x64.zip";
const DEB_SERIAL = "20261017-2634";
const DEB_IMG = "debian-13-genericcloud-amd64-" + DEB_SERIAL + ".qcow2";
// 官方 SHA512SUMS 里的值(CI 转存前也按它校验过)—— 不管从哪个源下,落盘后都按它验。
const DEB_SHA512 = "ec584ccabfef7120b4c4f7482adf0e615894d9292cedec446b64194b951ebe5dd97c336b5dcbae458333764b0edd516334506017f33c4f2020ef8d38b569ffe3";
const R2 = "https://r2.deepfetch.de5.net/releases";
const QEMU_SRCS = [R2 + "/qemu/" + QEMU_ZIP];
// R2 上是两片(wrangler 单文件上限 300MiB):数组 = 分片,按序下完拼回;字符串 = 整个文件。
const DEB_SRCS = [[R2 + "/debian/" + DEB_IMG + ".p0", R2 + "/debian/" + DEB_IMG + ".p1"], "https://cloud.debian.org/images/cloud/trixie/" + DEB_SERIAL + "/" + DEB_IMG];
// 宿主侧端口全部只绑 127.0.0.1(hostfwd 写死),外网/局域网碰不到。
const TTY_PORT = 17681, QMP_PORT = 17682, SEED_PORT = 17683, SSH_PORT = 17622;
// cloud-init 的 instance-id:改 user-data 内容时 +1,已装好的虚拟机下次开机会按新配置重跑一遍
// (users/write_files/runcmd 都是幂等的,数据不动)。2 = 注入 desktop 用的 SSH 公钥。
const PROVISION = 2;
const DISK_SIZE = "40G";

const home = os.homedir();
const WIN = process.platform === "win32";
const LAD = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
const qemuDir = path.join(LAD, "cicy-qemu");
const dlDir = path.join(LAD, "cicy-qemu-dl");
const vmDir = path.join(home, "cicy-ai", "vm", "debian");
const logDir = path.join(home, "cicy-ai", "logs");
for (const d of [vmDir, logDir, dlDir]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
const F = {
  base: path.join(vmDir, DEB_IMG), disk: path.join(vmDir, "disk.qcow2"), state: path.join(vmDir, "state.json"),
  console: path.join(logDir, "debian-console.log"), qemuLog: path.join(logDir, "debian-qemu.log"), runLog: path.join(logDir, "debian-run.log"),
  install: path.join(vmDir, "install.json"), runPid: path.join(vmDir, "run.pid"), qemuPid: path.join(vmDir, "qemu.pid"),
  key: path.join(vmDir, "id_rsa"), pub: path.join(vmDir, "id_rsa.pub"),
  zip: path.join(dlDir, QEMU_ZIP), img: path.join(dlDir, DEB_IMG),
};
const qemuExe = path.join(qemuDir, "qemu-system-x86_64.exe"), qemuImg = path.join(qemuDir, "qemu-img.exe"), ttydBin = path.join(qemuDir, "guest", "ttyd.x86_64");
const CURL = WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe") : "curl";
const TAR = WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";

function out(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } }
function writeJson(f, o) { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch {} }
function pidAlive(n) { if (!n) return false; try { process.kill(n, 0); return true; } catch { return false; } }
function readPid(f) { try { const n = Number(fs.readFileSync(f, "utf8").trim()); return n > 0 ? n : 0; } catch { return 0; } }
function size(f) { try { return fs.statSync(f).size; } catch { return 0; } }
function tailOf(file, max) { try { const st = fs.statSync(file); const len = Math.min(st.size, max); if (!len) return ""; const fd = fs.openSync(file, "r"); try { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); return b.toString("utf8"); } finally { fs.closeSync(fd); } } catch { return ""; } }
function log(msg) { try { fs.appendFileSync(F.runLog, new Date().toISOString() + " " + msg + "\n"); } catch {} }
function state() {
  let s = readJson(F.state);
  if (!s || !s.token) { s = { token: crypto.randomBytes(16).toString("hex"), created: Date.now() }; writeJson(F.state, s); }
  ensureKey();
  return s;
}
// desktop 进虚拟机跑 docker 用的 SSH 密钥(RSA PKCS1 PEM:ssh2 和 OpenSSH 都认)。
// 公钥按 OpenSSH 线格式手拼:string "ssh-rsa" + mpint e + mpint n。
function sshString(b) { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); }
function sshMpint(b) { if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return sshString(b); }
function ensureKey() {
  if (fs.existsSync(F.key) && fs.existsSync(F.pub)) return;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const jwk = publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([sshString(Buffer.from("ssh-rsa")), sshMpint(Buffer.from(jwk.e, "base64url")), sshMpint(Buffer.from(jwk.n, "base64url"))]);
  fs.writeFileSync(F.key, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(F.pub, "ssh-rsa " + blob.toString("base64") + " cicy-desktop\n");
}
function pubKey() { try { return fs.readFileSync(F.pub, "utf8").trim(); } catch { return ""; } }
function installed() { return fs.existsSync(qemuExe) && fs.existsSync(qemuImg) && fs.existsSync(F.base) && fs.existsSync(F.disk); }

// 后台起一个隐藏的 node 跑本脚本的某个 op(见文件头:为什么必须 Start-Process Hidden)。
function spawnHidden(op, logFile) {
  const q = (x) => "'" + String(x).replace(/'/g, "''") + "'";
  if (WIN) {
    const pidOut = path.join(vmDir, "spawn-" + op + ".pid");
    const cmd = "$p = Start-Process -FilePath " + q(process.execPath) + " -ArgumentList @(" + [__filename, op].map((a) => q('"' + a + '"')).join(",") + ")"
      + " -WindowStyle Hidden -RedirectStandardOutput " + q(logFile) + " -RedirectStandardError " + q(logFile + ".err")
      + " -WorkingDirectory " + q(vmDir) + " -PassThru; Set-Content -Path " + q(pidOut) + " -Value $p.Id";
    // Start-Process 带重定向时用继承句柄的 CreateProcess:后台 node 会顺手继承 powershell 的
    // stdout —— 若那是管道,spawnSync 要等后台进程退出才 EOF(= install/start 卡到超时)。
    // 所以 powershell 的 stdio 全给 ignore(NUL),PID 走文件。
    try { fs.unlinkSync(pidOut); } catch {}
    cp.spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", cmd], { stdio: "ignore", timeout: 60000, windowsHide: true });
    return readPid(pidOut);
  }
  const fd = fs.openSync(logFile, "a");
  const c = cp.spawn(process.execPath, [__filename, op], { detached: true, windowsHide: true, stdio: ["ignore", fd, fd], cwd: vmDir });
  c.unref(); try { fs.closeSync(fd); } catch {}
  return c.pid;
}

function hashFile(f, algo) {
  return new Promise((res) => {
    const h = crypto.createHash(algo), s = fs.createReadStream(f);
    s.on("data", (b) => h.update(b)); s.on("end", () => res(h.digest("hex"))); s.on("error", () => res(""));
  });
}
function curlText(url) {
  const r = cp.spawnSync(CURL, ["-fsSL", "--max-time", "30", url], { encoding: "utf8", windowsHide: true, timeout: 40000 });
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}
function curlTo(u, dest) {
  log("download " + u);
  const r = cp.spawnSync(CURL, ["-L", "-s", "-S", "-f", "-C", "-", "-o", dest + ".part", "--speed-limit", "100000", "--speed-time", "30", "--retry", "2", u], { encoding: "utf8", windowsHide: true, timeout: 3 * 3600 * 1000 });
  log("curl exit=" + r.status + " bytes=" + size(dest + ".part") + " " + String(r.stderr || "").trim().slice(-200));
  if (r.status === 0) { try { fs.renameSync(dest + ".part", dest); } catch { try { fs.copyFileSync(dest + ".part", dest); fs.unlinkSync(dest + ".part"); } catch {} } return fs.existsSync(dest); }
  // 33 = 服务器不支持续传 / 416 已下完但不认:清掉,下一个源从头来
  if (r.status === 33 || /416/.test(String(r.stderr || ""))) { try { fs.unlinkSync(dest + ".part"); } catch {} }
  return false;
}
// 分片源:每片单独续传下到 dest.pN,全齐了按序拼成 dest。进度条看的是 dest.part,
// 所以拼接前先把已下完的片的大小累计到 prog.base,status 用 base + 当前片 .part。
function downloadParts(parts, dest, prog) {
  let base = 0;
  for (let i = 0; i < parts.length; i++) {
    const pf = dest + ".p" + i;
    prog({ file: pf, base });
    if (!fs.existsSync(pf) && !curlTo(parts[i], pf)) return false;
    base += size(pf);
  }
  const fd = fs.openSync(dest + ".part", "w");
  try { for (let i = 0; i < parts.length; i++) { const b = fs.readFileSync(dest + ".p" + i); fs.writeSync(fd, b); } } finally { fs.closeSync(fd); }
  fs.renameSync(dest + ".part", dest);
  for (let i = 0; i < parts.length; i++) { try { fs.unlinkSync(dest + ".p" + i); } catch {} }
  prog({ file: dest, base: 0 });
  return true;
}
// 断点续传下载;一个源 30s 内低于 100KB/s 就换下一个。返回用了哪个源。
function download(srcs, dest, prog) {
  for (const u of srcs) {
    if (Array.isArray(u)) {
      prog({ src: u[0] });
      if (downloadParts(u, dest, prog)) return u[0];
      continue;
    }
    prog({ src: u, file: dest, base: 0 });
    if (curlTo(u, dest)) return u;
  }
  return "";
}

// ---- install-run:真正干活的后台进程,进度写 install.json,status 读它 ----
async function installRun() {
  const st = { pid: process.pid, phase: "qemu", started: Date.now(), error: "" };
  const prog = (o) => { Object.assign(st, o); writeJson(F.install, st); };
  prog({});
  try {
    if (!(fs.existsSync(qemuExe) && fs.existsSync(qemuImg) && fs.existsSync(ttydBin))) {
      prog({ phase: "qemu", file: F.zip, total: 44400000 });
      const want = curlText(QEMU_SRCS[0] + ".sha256").split(/\s+/)[0];
      if (!(fs.existsSync(F.zip) && want && (await hashFile(F.zip, "sha256")) === want)) {
        try { fs.unlinkSync(F.zip); } catch {}
        if (!download(QEMU_SRCS, F.zip, prog)) return prog({ error: "qemu_download" });
        if (want && (await hashFile(F.zip, "sha256")) !== want) { try { fs.unlinkSync(F.zip); } catch {} return prog({ error: "qemu_checksum" }); }
      }
      prog({ phase: "extract" });
      const tmp = path.join(dlDir, "x");
      fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
      const r = cp.spawnSync(TAR, ["-xf", F.zip, "-C", tmp], { encoding: "utf8", windowsHide: true, timeout: 600000 });
      if (r.status !== 0 || !fs.existsSync(path.join(tmp, "cicy-qemu", "qemu-system-x86_64.exe"))) return prog({ error: "qemu_extract", detail: String(r.stderr || "").slice(-300) });
      fs.rmSync(qemuDir, { recursive: true, force: true });
      fs.renameSync(path.join(tmp, "cicy-qemu"), qemuDir);
      fs.rmSync(tmp, { recursive: true, force: true }); try { fs.unlinkSync(F.zip); } catch {}
    }
    if (!fs.existsSync(F.base)) {
      prog({ phase: "image", file: F.img, total: 342818816 });
      if (!(fs.existsSync(F.img) && (await hashFile(F.img, "sha512")) === DEB_SHA512)) {
        try { fs.unlinkSync(F.img); } catch {}
        if (!download(DEB_SRCS, F.img, prog)) return prog({ error: "image_download" });
        prog({ phase: "verify" });
        if ((await hashFile(F.img, "sha512")) !== DEB_SHA512) { try { fs.unlinkSync(F.img); } catch {} return prog({ error: "image_checksum" }); }
      }
      try { fs.renameSync(F.img, F.base); } catch { fs.copyFileSync(F.img, F.base); fs.unlinkSync(F.img); }
    }
    if (!fs.existsSync(F.disk)) {
      prog({ phase: "disk" });
      // 底盘只读,用户数据全在 overlay;以后换 Debian 底盘只要 rebase,不丢数据。
      const r = cp.spawnSync(qemuImg, ["create", "-f", "qcow2", "-F", "qcow2", "-b", path.basename(F.base), F.disk, DISK_SIZE], { encoding: "utf8", windowsHide: true, timeout: 120000, cwd: vmDir });
      if (r.status !== 0) return prog({ error: "disk_create", detail: String(r.stderr || r.stdout || "").slice(-300) });
    }
    state();
    prog({ phase: "done", done: Date.now() });
  } catch (e) { prog({ error: "exception", detail: String(e && e.message || e).slice(0, 300) }); }
}

// ---- cloud-init NoCloud 种子:虚拟机经 slirp 的 10.0.2.2 访问宿主 127.0.0.1:SEED_PORT ----
function userData(tok) {
  return [
    "#cloud-config",
    "hostname: cicy-debian",
    "timezone: Asia/Shanghai",
    "users:",
    "  - name: cicy",
    "    shell: /bin/bash",
    "    groups: [sudo]",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    lock_passwd: true",
    "    ssh_authorized_keys:",
    "      - " + pubKey(),
    "ssh_pwauth: false",
    "write_files:",
    "  - path: /etc/systemd/system/cicy-ttyd.service",
    "    content: |",
    "      [Unit]",
    "      Description=cicy web terminal",
    "      After=network-online.target",
    "      [Service]",
    "      User=cicy",
    "      WorkingDirectory=/home/cicy",
    "      Environment=HOME=/home/cicy",
    "      ExecStart=/usr/local/bin/ttyd -W -p 7681 -b /" + tok + " -t titleFixed=Debian -t fontSize=14 bash -l",
    "      Restart=always",
    "      RestartSec=2",
    "      [Install]",
    "      WantedBy=multi-user.target",
    "runcmd:",
    "  - [python3, -c, \"import urllib.request as u; open('/usr/local/bin/ttyd','wb').write(u.urlopen('http://10.0.2.2:" + SEED_PORT + "/ttyd', timeout=120).read())\"]",
    "  - [chmod, '0755', /usr/local/bin/ttyd]",
    "  - [systemctl, daemon-reload]",
    "  - [systemctl, enable, --now, cicy-ttyd.service]",
    "",
  ].join("\n");
}
function seedServer(tok) {
  const srv = http.createServer((req, res) => {
    const u = String(req.url || "").split("?")[0];
    log("seed " + req.method + " " + u);
    if (u === "/meta-data") { res.end("instance-id: cicy-debian-" + PROVISION + "\nlocal-hostname: cicy-debian\n"); return; }
    if (u === "/user-data") { res.end(userData(tok)); return; }
    if (u === "/vendor-data" || u === "/network-config") { res.end(""); return; }
    if (u === "/ttyd") { res.setHeader("content-type", "application/octet-stream"); fs.createReadStream(ttydBin).pipe(res); return; }
    res.statusCode = 404; res.end();
  });
  srv.on("error", (e) => log("seed server error: " + e.message));
  srv.listen(SEED_PORT, "127.0.0.1");
  return srv;
}

function vmSize() {
  const totalMb = Math.floor(os.totalmem() / 1048576), cpus = os.cpus().length || 2;
  const mem = Math.max(1024, Math.min(4096, Math.floor(totalMb / 4 / 256) * 256));
  return { mem, smp: Math.max(1, Math.min(4, Math.floor(cpus / 2))) };
}
// ---- run:后台常驻,开种子服务 + 拉起 qemu,qemu 退出它就退出 ----
function run() {
  const s = state(), { mem, smp } = vmSize();
  fs.writeFileSync(F.runPid, String(process.pid));
  writeJson(F.state, Object.assign(readJson(F.state) || s, { bootProvision: PROVISION }));
  const srv = seedServer(s.token);
  const args = [
    "-name", "cicy-debian",
    "-accel", "whpx,kernel-irqchip=off", "-accel", "tcg,thread=multi",
    "-m", String(mem), "-smp", String(smp),
    "-drive", "file=" + F.disk + ",if=virtio,cache=writeback,discard=unmap",
    "-netdev", "user,id=n0,hostfwd=tcp:127.0.0.1:" + TTY_PORT + "-:7681,hostfwd=tcp:127.0.0.1:" + SSH_PORT + "-:22",
    "-device", "virtio-net-pci,netdev=n0",
    "-smbios", "type=1,serial=ds=nocloud;s=http://10.0.2.2:" + SEED_PORT + "/",
    "-qmp", "tcp:127.0.0.1:" + QMP_PORT + ",server=on,wait=off",
    "-display", "none", "-vga", "none",
    "-serial", "file:" + F.console,
  ];
  log("qemu " + JSON.stringify(args));
  const lfd = fs.openSync(F.qemuLog, "w");
  const q = cp.spawn(qemuExe, args, { cwd: qemuDir, windowsHide: true, stdio: ["ignore", lfd, lfd] });
  fs.writeFileSync(F.qemuPid, String(q.pid));
  q.on("exit", (code) => { log("qemu exit " + code); try { fs.unlinkSync(F.qemuPid); } catch {} try { fs.unlinkSync(F.runPid); } catch {} srv.close(); process.exit(0); });
  q.on("error", (e) => { log("qemu spawn error " + e.message); process.exit(1); });
}

function qmp(cmds, timeoutMs) {
  return new Promise((res) => {
    const sock = net.connect(QMP_PORT, "127.0.0.1"); let buf = "", sent = false; const replies = [];
    const done = (v) => { try { sock.destroy(); } catch {} res(v); };
    const t = setTimeout(() => done(replies.length ? replies : null), timeoutMs || 5000);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i; while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.QMP && !sent) { sent = true; for (const c of [{ execute: "qmp_capabilities" }, ...cmds]) sock.write(JSON.stringify(c) + "\n"); continue; }
        if ("return" in j || "error" in j) { replies.push(j); if (replies.length === cmds.length + 1) { clearTimeout(t); done(replies.slice(1)); } }
      }
    });
    sock.on("error", () => { clearTimeout(t); done(null); });
  });
}
function httpOk(port, p) {
  return new Promise((res) => {
    const r = http.get({ host: "127.0.0.1", port, path: p, timeout: 3000 }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("timeout", () => { r.destroy(); res(false); }); r.on("error", () => res(false));
  });
}
function accelOf() {
  const t = tailOf(F.qemuLog, 32 * 1024);
  if (!t && !pidAlive(readPid(F.qemuPid))) return "";
  // qemu 依次试 -accel:whpx 起不来会打一行 WHPX 报错再退到 tcg
  return /whpx/i.test(t) && /(fail|error|no accelerator|not supported|unavailable)/i.test(t) ? "tcg" : "whpx";
}
function whpxFeature() { return WIN && fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WinHvPlatform.dll")); }
// 串口日志最后一行可读的话 = 开机进度(给卡片「启动中」下面那一行小字)
function bootLine() {
  const t = tailOf(F.console, 8 * 1024).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && /[A-Za-z]/.test(l));
  return (t.pop() || "").slice(0, 160);
}

async function status() {
  const inst = readJson(F.install), instPid = inst && inst.pid;
  const installing = !!(inst && !inst.done && !inst.error && pidAlive(instPid));
  let bytes = 0; if (installing && inst.file) bytes = (inst.base || 0) + (size(inst.file + ".part") || size(inst.file));
  const qpid = readPid(F.qemuPid), running = pidAlive(qpid);
  const s = readJson(F.state);
  const ready = running && s && s.token ? await httpOk(TTY_PORT, "/" + s.token + "/") : false;
  return {
    ok: true, platform: process.platform, installed: installed(), installing,
    phase: inst && inst.phase, bytes, total: inst && inst.total, src: inst && inst.src,
    installError: inst && !installing && inst.error ? [inst.error, inst.detail].filter(Boolean).join(" · ") : "",
    running, ready, accel: running ? accelOf() : "", whpxFeature: whpxFeature(),
    boot: running && !ready ? bootLine() : "", ...vmSize(), sshPort: SSH_PORT, qmpPort: QMP_PORT,
    provision: running ? (readJson(F.state) || {}).bootProvision || 0 : 0, key: F.key,
  };
}
async function install() {
  const s = await status();
  if (s.installed) return { ok: true, already: true };
  if (s.installing) return { ok: true, installing: true };
  try { fs.unlinkSync(F.install); } catch {}
  const pid = spawnHidden("install-run", path.join(logDir, "debian-install.log"));
  return pid ? { ok: true, pid } : { ok: false, error: "spawn_failed" };
}
async function start() {
  if (!installed()) return { ok: false, error: "not_installed" };
  if (pidAlive(readPid(F.qemuPid))) return { ok: true, already: true };
  for (const p of [TTY_PORT, QMP_PORT, SEED_PORT, SSH_PORT]) {
    const busy = await new Promise((res) => { const c = net.connect(p, "127.0.0.1"); c.on("connect", () => { c.destroy(); res(true); }); c.on("error", () => res(false)); });
    if (busy) return { ok: false, error: "port_in_use", detail: "127.0.0.1:" + p };
  }
  try { fs.writeFileSync(F.console, ""); } catch {}
  const pid = spawnHidden("run", F.runLog + ".out");
  if (!pid) return { ok: false, error: "spawn_failed" };
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (pidAlive(readPid(F.qemuPid))) return { ok: true, pid }; }
  return { ok: false, error: "qemu_not_started", tail: tailOf(F.qemuLog, 1200) + tailOf(F.runLog, 800) };
}
async function stop() {
  const qpid = readPid(F.qemuPid);
  if (!pidAlive(qpid)) return { ok: true, already: true };
  await qmp([{ execute: "system_powerdown" }], 5000);   // 先 ACPI 关机,让 Debian 自己落盘
  for (let i = 0; i < 60 && pidAlive(qpid); i++) await new Promise((r) => setTimeout(r, 1000));
  if (pidAlive(qpid)) { await qmp([{ execute: "quit" }], 3000); await new Promise((r) => setTimeout(r, 1500)); }
  if (pidAlive(qpid)) { try { process.kill(qpid); } catch {} }
  return { ok: !pidAlive(qpid) };
}
async function open() {
  const s = readJson(F.state);
  if (!s || !s.token || !(await httpOk(TTY_PORT, "/" + s.token + "/"))) return { ok: false, error: "not_ready" };
  return { ok: true, url: "http://127.0.0.1:" + TTY_PORT + "/" + s.token + "/" };
}
// 运行时加端口转发(宿主 127.0.0.1:P → 虚拟机 :P),走 QMP 的 HMP hostfwd_add。
// 开机才有效、关机即失;重复添加 qemu 会报错,当作已存在。只绑 127.0.0.1。
async function fwd(ports) {
  const want = ports.map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (!pidAlive(readPid(F.qemuPid))) return { ok: false, error: "not_running" };
  const r = await qmp(want.map((p) => ({ execute: "human-monitor-command", arguments: { "command-line": "hostfwd_add n0 tcp:127.0.0.1:" + p + "-:" + p } })), 8000);
  if (!r) return { ok: false, error: "qmp_unreachable" };
  return { ok: true, ports: want, replies: r.map((x) => String((x && x.return) || (x && x.error && x.error.desc) || "").trim()) };
}
// 开启 WHPX:弹 UAC,管理员 PowerShell 打开「Windows 虚拟机监控程序平台」,之后要重启电脑。
function accel() {
  if (!WIN) return { ok: false, error: "windows_only" };
  const inner = "Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart | Out-Null";
  const cmd = "$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-Command','" + inner.replace(/'/g, "''") + "'); $p.ExitCode";
  const r = cp.spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", cmd], { encoding: "utf8", timeout: 600000, windowsHide: true });
  const code = Number(String(r.stdout || "").trim().split(/\s+/).pop());
  if (r.status !== 0 || code !== 0) return { ok: false, error: "enable_failed", detail: String(r.stderr || r.stdout || "").trim().slice(-300) };
  return { ok: true, needReboot: true };
}

(async () => {
  try {
    if (OP === "install-run") return await installRun();
    if (OP === "run") return run();
    out(OP === "install" ? await install() : OP === "start" ? await start() : OP === "stop" ? await stop() : OP === "open" ? await open() : OP === "accel" ? accel() : OP === "fwd" ? await fwd(process.argv.slice(3)) : await status());
  } catch (e) { out({ ok: false, error: "exception", detail: String(e && e.message || e).slice(0, 300) }); }
})();
