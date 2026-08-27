// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Main-process side of the Redroid matrix panel (cicyui://panel?preset=redroid-matrix).
//
// Redroid = containerised Android (no QEMU). The devices live as docker
// containers inside the cicy WSL distro (Windows) or the local docker (mac /
// linux), and everything the panel does is `docker …` + `adb …` executed
// there. The page talks to us over window.redroidAPI (panel-preload.js).
//
// Gotchas baked in (see knowledge base "redroid 容器化 Android 在 WSL2 上跑起来"):
//   • host adb port must be ≥ 15555 — 5555-5585 is adb's emulator range and the
//     device stays "offline" forever.
//   • redroid's netd has no policy-routing rule to the main table, so the
//     container can't answer adb / reach the proxy until
//     `ip rule add from all lookup main pref 17000` is added — and netd flushes
//     it again, so a watchdog (redroid-net.sh) re-asserts it every 10 s for
//     EVERY redroid container.
//   • root is AOSP-native: `su <uid> <cmd>` (not `su -c`).
const { ipcMain, dialog, BrowserWindow } = require("electron");
const path = require("path");
const { execFile } = require("child_process");
const core = require("./redroid-matrix-core");

const WATCHDOG = "/usr/local/sbin/redroid-net.sh";
const FRIDA_SERVER_SRC = process.env.CICY_FRIDA_SERVER || "/mnt/c/wsl/frida-server";
const FRIDA_PORT = 27042;
const IP_API = "http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,isp,org,as,mobile,proxy,hosting";

// ── runner ───────────────────────────────────────────────────────────────────
// Short commands go through a persistent shell session (redroid-shell.js):
// lane "ui" for screenshots/input, lane "mgmt" for docker/adb status+actions.
// Long jobs (image pull, apk install, purge) use a one-off process so they
// never wedge a lane.
const { lane } = require("./redroid-shell");
function sh(cmd, { timeout = 30000, lane: laneName = "mgmt" } = {}) {
  return lane(laneName).run(cmd, { timeout });
}
function shOnce(cmd, { timeout = 60000 } = {}) {
  if (process.platform === "win32") return require("../sidecar/wsl-docker").wslRun(cmd, { timeout });
  return new Promise((resolve, reject) => {
    execFile("bash", ["-lc", cmd], { timeout, maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      if (err) { err.stdout = String(stdout || ""); err.stderr = String(stderr || ""); return reject(err); }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
const errText = (e) => {
  const tail = String((e && (e.stderr || e.stdout)) || "").trim().split("\n").slice(-3).join(" ");
  if (tail) return tail;
  if (e && e.killed) return `命令超时：${e.message}`;
  return (e && e.message) || String(e);
};
function toDistroPath(p) {
  if (process.platform !== "win32") return p;
  return String(p).replace(/^([A-Za-z]):[\\/]/, (_m, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

// ── adb ──────────────────────────────────────────────────────────────────────
const serial = (port) => `127.0.0.1:${port}`;
function adb(port, args, { timeout = 20000, lane: laneName } = {}) {
  return sh(`adb -s ${serial(port)} ${args}`, { timeout, lane: laneName });
}
async function adbState(port) {
  try {
    const { stdout } = await sh("adb devices", { timeout: 10000 });
    const m = new RegExp(`^${serial(port).replace(".", "\\.")}\\s+(\\S+)`, "m").exec(stdout);
    return m ? m[1] : "disconnected";
  } catch { return "disconnected"; }
}
// adb connect is idempotent; a stale "offline" entry is fixed by disconnect+connect.
async function ensureConnected(port) {
  let st = await adbState(port);
  if (st === "device") return st;
  if (st === "offline") { try { await sh(`adb disconnect ${serial(port)}`, { timeout: 8000 }); } catch {} }
  try { await sh(`adb connect ${serial(port)}`, { timeout: 10000 }); } catch {}
  return adbState(port);
}

// ── docker ───────────────────────────────────────────────────────────────────
async function dockerList() {
  const { stdout } = await sh("docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'", { timeout: 20000 });
  return core.parsePs(stdout);
}
async function findDevice(name) {
  const dev = (await dockerList()).find((d) => d.name === name);
  if (!dev) throw new Error(`设备 ${name} 不存在`);
  return dev;
}

// Generalised watchdog: the original one only knew the container named
// "redroid". This version walks every running redroid/redroid container.
const WATCHDOG_BODY = `#!/bin/sh
# cicy redroid network watchdog — re-asserts main-table routing inside every
# redroid container (netd flushes it). Installed by cicy-desktop Redroid 矩阵.
while true; do
  for c in $(docker ps --filter ancestor=redroid/redroid:11.0.0-latest --filter ancestor=redroid/redroid:13.0.0-latest --filter ancestor=redroid/redroid:14.0.0-latest --format '{{.Names}}' 2>/dev/null; docker ps --filter label=cicy.redroid=1 --format '{{.Names}}' 2>/dev/null); do
    docker exec "$c" getprop sys.boot_completed 2>/dev/null | grep -q 1 || continue
    IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$c" 2>/dev/null)
    GW=$(echo "$IP" | sed 's/\\.[0-9]*$/.1/')
    docker exec "$c" sh -c "
      ip rule | grep -q 17000 || ip rule add from all lookup main pref 17000
      ip route | grep -q '^default' || ip route add default via $GW dev eth0
    " 2>/dev/null
  done
  date +%s > /var/run/redroid-net.heartbeat
  sleep 10
done
`;
async function ensureWatchdog() {
  const marker = "cicy redroid network watchdog";
  try {
    const { stdout } = await sh(`grep -c ${q(marker)} ${WATCHDOG} 2>/dev/null; pgrep -f redroid-net.sh >/dev/null && echo RUN`, { timeout: 10000 });
    if (/^1/.test(stdout) && /RUN/.test(stdout)) return;
  } catch {}
  const script = `cat > ${WATCHDOG} <<'CICY_EOF'\n${WATCHDOG_BODY}CICY_EOF\nchmod +x ${WATCHDOG}; pkill -f redroid-net.sh; nohup ${WATCHDOG} >/dev/null 2>&1 & disown; ` +
    `grep -q redroid-net.sh /usr/local/sbin/start-dockerd.sh 2>/dev/null || (test -f /usr/local/sbin/start-dockerd.sh && printf '\\nnohup ${WATCHDOG} >/dev/null 2>&1 &\\n' >> /usr/local/sbin/start-dockerd.sh); true`;
  await sh(script, { timeout: 20000 });
}

// ── device info / actions ────────────────────────────────────────────────────
async function deviceInfo(dev) {
  const info = { adb: "disconnected", booted: false, root: null, frida: false, proxy: "", model: "", release: "", fridaPort: dev.port + 10000 };
  if (!dev.running || !dev.port) return info;
  info.adb = await ensureConnected(dev.port);
  if (info.adb !== "device") return info;
  try {
    const { stdout } = await adb(dev.port, `shell "getprop sys.boot_completed; getprop ro.build.version.release; getprop ro.product.model; settings get global http_proxy; (su 0 id 2>/dev/null || echo NOSU); (pgrep -f frida-server >/dev/null 2>&1 && echo FRIDA || ps -A 2>/dev/null | grep -q frida-server && echo FRIDA || echo NOFRIDA); wm size 2>/dev/null | tail -1; cat /proc/uptime 2>/dev/null | cut -d. -f1; getprop ro.build.fingerprint"`);
    const l = stdout.replace(/\r/g, "").split("\n").map((s) => s.trim());
    info.booted = l[0] === "1";
    info.release = l[1] || ""; info.model = l[2] || "";
    info.proxy = l[3] && l[3] !== "null" && l[3] !== ":0" ? l[3] : "";
    info.root = /uid=0/.test(l[4] || "");
    info.frida = /^FRIDA$/m.test(stdout);
    const rest = l.slice(5).filter((x) => !/^(NO)?FRIDA$/.test(x));
    const wm = rest.find((x) => /size:/i.test(x)); info.size = wm ? wm.replace(/.*size:\s*/i, "") : "";
    const up = rest.find((x) => /^\d+$/.test(x)); info.uptime = up ? Number(up) : null;
    info.fingerprint = rest.find((x) => /\//.test(x) && /:/.test(x)) || "";
  } catch (e) { info.error = errText(e); }
  return info;
}

async function screenshot(port) {
  const { stdout } = await adb(port, "exec-out screencap -p | base64 -w0", { timeout: 15000, lane: "ui" });
  const b64 = stdout.replace(/\s+/g, "");
  if (b64.length < 100 || !b64.startsWith("iVBOR") || /[^A-Za-z0-9+/=]/.test(b64)) throw new Error("screencap 返回异常数据");
  return `data:image/png;base64,${b64}`;
}

async function sendInput(port, ev) {
  await adb(port, `shell ${core.inputArgs(ev).join(" ")}`, { timeout: 10000, lane: "ui" });
}

async function setProxy(port, proxy) {
  const v = core.normalizeDeviceProxy(proxy);
  await adb(port, `shell settings put global http_proxy ${v ? q(v) : "':0'"}`);
  return v;
}

// Egress as the DEVICE sees it: through its configured proxy (probed from the
// distro, which sits on the same docker bridge). Direct = the distro's own
// egress. Merges ip-api.com (geo/isp/flags) with ipapi.is (datacenter/vpn/tor/
// abuser) and grades the result (core.classifyIp).
async function fetchJsonVia(url, via) {
  const py = `import json,sys,urllib.request as u; h=u.ProxyHandler({'http':'http://${via}','https':'http://${via}'} if ${via ? "True" : "False"} else {}); print(u.build_opener(h).open(sys.argv[1],timeout=12).read().decode())`;
  const r = await sh(`if command -v curl >/dev/null; then curl -s --max-time 12 ${via ? `-x http://${via}` : ""} ${q(url)}; else python3 -c ${q(py)} ${q(url)}; fi`, { timeout: 20000 });
  try { return JSON.parse(r.stdout); } catch { throw new Error(`探测服务无响应：${r.stdout.trim().slice(-120) || "empty"}`); }
}
async function probeIp(port) {
  const { stdout } = await adb(port, "shell settings get global http_proxy");
  const proxy = stdout.trim();
  const via = proxy && proxy !== "null" && proxy !== ":0" ? proxy : "";
  const a = await fetchJsonVia(IP_API, via);
  if (!a || a.status !== "success") throw new Error(`出口探测失败${via ? `（经 ${via}）` : ""}：${(a && a.message) || "ip-api 无结果"}`);
  let b = null;
  try { b = await fetchJsonVia(`https://api.ipapi.is/?q=${a.query}`, via); } catch {}
  const cls = core.classifyIp({ ipapi: a, ipapis: b });
  return {
    ip: a.query, cc: a.countryCode || (b && b.cc) || "", country: a.country || "", region: a.regionName || "", city: a.city || "",
    area: [a.country, a.regionName, a.city].filter(Boolean).join(" · "),
    isp: a.isp || "", org: a.org || "", as: a.as || (b && b.asn_num ? `AS${b.asn_num} ${b.asn_org || ""}` : ""),
    ...cls, sources: { ipapi: !!a, ipapis: !!b },
    via: via || "direct", probedAt: new Date().toISOString(),
  };
}

async function frida(dev, on) {
  const port = dev.port;
  if (!on) {
    await adb(port, `shell "su 0 pkill -f frida-server; pkill -f frida-server" || true`);
    try { await sh(`adb -s ${serial(port)} forward --remove tcp:${port + 10000}`); } catch {}
    return false;
  }
  const { stdout } = await adb(port, "shell 'ls /data/local/tmp/frida-server 2>/dev/null || echo MISSING'");
  if (/MISSING/.test(stdout)) {
    try { await sh(`test -f ${q(FRIDA_SERVER_SRC)}`); }
    catch { throw new Error(`frida-server 不存在：${FRIDA_SERVER_SRC}（x86_64 Android 版，可用 CICY_FRIDA_SERVER 指定）`); }
    await shOnce(`adb -s ${serial(port)} push ${q(FRIDA_SERVER_SRC)} /data/local/tmp/frida-server`, { timeout: 60000 });
  }
  await adb(port, `shell "chmod 755 /data/local/tmp/frida-server; su 0 sh -c 'nohup /data/local/tmp/frida-server -D -l 0.0.0.0:${FRIDA_PORT} >/dev/null 2>&1 &'"`);
  await sh(`adb -s ${serial(port)} forward tcp:${port + 10000} tcp:${FRIDA_PORT}`);
  await new Promise((r) => setTimeout(r, 800));
  const chk = await adb(port, "shell 'pgrep -f frida-server >/dev/null && echo OK || (ps -A | grep -q frida-server && echo OK || echo NO)'");
  if (!/OK/.test(chk.stdout)) throw new Error("frida-server 启动失败（需要 root）");
  return true;
}

async function listApps(port) {
  const { stdout } = await adb(port, "shell pm list packages -3");
  return stdout.split(/\r?\n/).map((s) => s.replace(/^package:/, "").trim()).filter(Boolean).sort();
}

async function installApk(port, hostPath, emit) {
  const p = toDistroPath(hostPath);
  const ext = path.extname(hostPath).toLowerCase();
  emit && emit({ message: `安装 ${path.basename(hostPath)} …` });
  if (ext === ".apk") {
    const r = await shOnce(`adb -s ${serial(port)} install -r -g ${q(p)}`, { timeout: 300000 });
    if (!/Success/i.test(r.stdout + r.stderr)) throw new Error(errText({ stdout: r.stdout, stderr: r.stderr }));
    return;
  }
  // xapk / apks / zip bundles → unpack the split apks and install-multiple
  const tmp = `/tmp/cicy-apk-${port}`;
  const r = await shOnce(`rm -rf ${tmp} && mkdir -p ${tmp} && unzip -o -j ${q(p)} '*.apk' -d ${tmp} >/dev/null && adb -s ${serial(port)} install-multiple -r -g ${tmp}/*.apk; rc=$?; rm -rf ${tmp}; exit $rc`, { timeout: 300000 });
  if (!/Success/i.test(r.stdout + r.stderr)) throw new Error(errText({ stdout: r.stdout, stderr: r.stderr }));
}

async function imagePresent(image) {
  try { await sh(`docker image inspect ${image} >/dev/null 2>&1`, { timeout: 10000 }); return true; } catch { return false; }
}

async function createDevice(input, emit) {
  const spec = core.normalizeSpec(input);
  const container = core.containerName(input.name);
  const existing = await dockerList();
  if (existing.some((d) => d.name === container)) throw new Error(`设备 ${container} 已存在`);
  const port = core.allocatePort(existing.map((d) => d.port));
  if (!(await imagePresent(spec.image))) {
    emit && emit({ message: `拉取镜像 ${spec.image}（约 3GB，首次较慢）…` });
    const r = await shOnce(`docker pull ${spec.image} 2>&1 | tail -3`, { timeout: 3600000 });
    if (!(await imagePresent(spec.image))) throw new Error(`镜像拉取失败：${r.stdout.trim().slice(-300)}`);
  }
  emit && emit({ message: `启动容器 ${container}（端口 ${port}）…` });
  await sh(core.buildRunCommand({ container, port, spec }), { timeout: 120000 });
  await ensureWatchdog();
  // adb connect in the background — boot takes ~30-60 s; the panel polls status.
  setTimeout(() => { ensureConnected(port).catch(() => {}); }, 20000);
  const proxy = String(input.proxy || "").trim();
  if (proxy) {
    core.normalizeDeviceProxy(proxy);
    waitBootThen(port, () => setProxy(port, proxy)).catch(() => {});
  }
  return { name: container, port, version: spec.version };
}

async function waitBootThen(port, fn, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      if ((await ensureConnected(port)) !== "device") continue;
      const { stdout } = await adb(port, "shell getprop sys.boot_completed", { timeout: 8000 });
      if (stdout.trim() === "1") return fn();
    } catch {}
  }
}

async function removeDevice(name, purge) {
  await findDevice(name);
  const p = purge ? ` && rm -rf ${q(core.dataDir(name))}` : "";
  await shOnce(`docker rm -f ${q(name)}${p}`, { timeout: 60000 });
}

// ── IPC ──────────────────────────────────────────────────────────────────────
let installed = false;
function installIpc(findTab) {
  if (installed) return;
  installed = true;
  // Only the panel page (profile 0) may drive this; same gate as panel-cells.
  const guard = (e) => { if (!findTab(e.sender.id)) throw new Error("not a panel page"); };
  const emitter = (e) => (m) => { try { e.sender.send("redroid:progress", m); } catch {} };
  // device lookup cache: the screen stream asks several times a second and a
  // `docker ps` per frame would saturate the mgmt lane.
  let cache = { at: 0, list: [] };
  const cachedList = async () => { if (Date.now() - cache.at > 5000) cache = { at: Date.now(), list: await dockerList() }; return cache.list; };
  const withDev = async (e, name) => {
    guard(e);
    const d = (await cachedList()).find((x) => x.name === name) || await findDevice(name);
    if (!d.running || !d.port) throw new Error(`${name} 未运行`);
    return d;
  };
  const h = (ch, fn) => ipcMain.handle(ch, async (e, a = {}) => {
    try { return await fn(e, a); }
    catch (err) { throw new Error(errText(err)); }
  });

  h("redroid:list", async (e) => {
    guard(e);
    const devs = await dockerList();
    cache = { at: Date.now(), list: devs };
    const out = [];
    for (const d of devs) out.push({ ...d, info: await deviceInfo(d) }); // serial: one lane, keep it orderly
    return out;
  });
  h("redroid:create", (e, a) => createDevice(a, emitter(e)));
  h("redroid:start", async (e, { name }) => { guard(e); await findDevice(name); await sh(`docker start ${q(name)}`, { timeout: 60000 }); await ensureWatchdog(); });
  h("redroid:stop", async (e, { name }) => { guard(e); await findDevice(name); await sh(`docker stop ${q(name)}`, { timeout: 60000 }); });
  h("redroid:restart", async (e, { name }) => { guard(e); await findDevice(name); await sh(`docker restart ${q(name)}`, { timeout: 90000 }); });
  h("redroid:remove", (e, { name, purge }) => { guard(e); return removeDevice(name, !!purge); });
  h("redroid:screenshot", async (e, { name }) => screenshot((await withDev(e, name)).port));
  h("redroid:input", async (e, { name, event }) => sendInput((await withDev(e, name)).port, event));
  h("redroid:set-proxy", async (e, { name, proxy }) => setProxy((await withDev(e, name)).port, proxy));
  h("redroid:probe-ip", async (e, { name }) => probeIp((await withDev(e, name)).port));
  h("redroid:frida", async (e, { name, on }) => frida(await withDev(e, name), !!on));
  h("redroid:apps", async (e, { name }) => listApps((await withDev(e, name)).port));
  h("redroid:launch", async (e, { name, pkg }) => { const d = await withDev(e, name); await adb(d.port, `shell monkey -p ${q(pkg)} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || am start -n ${q(pkg)}`); });
  h("redroid:uninstall", async (e, { name, pkg }) => { const d = await withDev(e, name); await adb(d.port, `uninstall ${q(pkg)}`, { timeout: 60000 }); });
  h("redroid:install", async (e, { name }) => {
    const d = await withDev(e, name);
    const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: "选择 APK / XAPK", properties: ["openFile", "multiSelections"], filters: [{ name: "Android 安装包", extensions: ["apk", "xapk", "apks", "zip"] }] });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    for (const f of r.filePaths) await installApk(d.port, f, emitter(e));
    return { installed: r.filePaths.map((f) => path.basename(f)) };
  });
  h("redroid:shell", async (e, { name, cmd }) => {
    const d = await withDev(e, name);
    const c = String(cmd || "").trim(); if (!c) return "";
    try { const r = await adb(d.port, `shell ${q(c)}`, { timeout: 30000 }); return r.stdout + (r.stderr ? "\n" + r.stderr : ""); }
    catch (err) { return (err.stdout || "") + (err.stderr || "") || err.message; }
  });
  h("redroid:defaults", async (e) => {
    guard(e);
    // the mihomo (cicy-code) container IP on the docker bridge: the natural proxy host for devices
    let host = "";
    try { host = (await sh("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cicy-code-docker-8008", { timeout: 10000 })).stdout.trim(); } catch {}
    return { proxyHint: host ? `${host}:20011` : "", images: core.IMAGES, spec: core.DEFAULT_SPEC, fridaServer: FRIDA_SERVER_SRC };
  });
}

module.exports = { installIpc, deviceInfo, createDevice, removeDevice, screenshot, sendInput, setProxy, probeIp, frida, listApps, installApk, ensureWatchdog, WATCHDOG_BODY, toDistroPath };
