const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolvePanelPreset } = require("../src/tabbrowser/panel-presets");
const { panelPageForUrl } = require("../src/tabbrowser/panel-page-router");
const core = require("../src/tabbrowser/redroid-matrix-core");

test("Redroid matrix preset routes to its dedicated page", () => {
  assert.deepEqual(resolvePanelPreset("redroid-matrix"), { preset: "redroid-matrix", title: "Redroid 矩阵", query: "preset=redroid-matrix" });
  assert.equal(panelPageForUrl("cicyui://panel/abc?preset=redroid-matrix"), "redroid-matrix.html");
  assert.ok(fs.existsSync(path.join(__dirname, "..", "src", "tabbrowser", "redroid-matrix.html")));
});

test("container names are slugged and host ports skip adb's emulator range", () => {
  assert.equal(core.containerName(" TG 01 "), "redroid-tg-01");
  assert.throws(() => core.containerName("!!!"), /设备名/);
  assert.equal(core.allocatePort([]), 15555);
  assert.equal(core.allocatePort([15555, 15556]), 15557);
  assert.equal(core.allocatePort([15556]), 15555); // holes are reused
});

test("docker run line carries the redroid boot args, label and data volume", () => {
  const cmd = core.buildRunCommand({ container: "redroid-a", port: 15557, spec: { version: "11", width: "1080", height: "1920", dpi: "420" } });
  assert.match(cmd, /^docker run -d --name redroid-a --label cicy\.redroid=1 /);
  assert.match(cmd, / --privileged /);
  assert.match(cmd, / -v \/root\/redroid-a-data:\/data /);
  assert.match(cmd, / -p 15557:5555 redroid\/redroid:11\.0\.0-latest androidboot\.redroid_gpu_mode=guest androidboot\.redroid_width=1080 androidboot\.redroid_height=1920 androidboot\.redroid_dpi=420$/);
  assert.throws(() => core.normalizeSpec({ version: "9" }), /不支持/);
  assert.equal(core.normalizeSpec({ width: "abc" }).width, 720); // bad numbers fall back to defaults
});

test("docker ps output is filtered to redroid images with their host adb port", () => {
  const out = [
    "redroid11\tredroid/redroid:11.0.0-latest\trunning\tUp 40 hours\t0.0.0.0:15556->5555/tcp, [::]:15556->5555/tcp",
    "redroid\tredroid/redroid:13.0.0-latest\trunning\tUp 43 hours\t0.0.0.0:15555->5555/tcp, [::]:15555->5555/tcp",
    "redroid-x\tredroid/redroid:13.0.0-latest\texited\tExited (0) 2 hours ago\t",
    "cicy-code-docker-8008\tcicybot/cicy-code:latest\trunning\tUp 35 hours\t127.0.0.1:8008->8008/tcp",
  ].join("\n");
  const list = core.parsePs(out);
  assert.deepEqual(list.map((d) => [d.name, d.version, d.port, d.running]), [
    ["redroid-x", "13", null, false],
    ["redroid", "13", 15555, true],
    ["redroid11", "11", 15556, true],
  ]);
});

test("device proxy accepts host:port (with or without scheme) and rejects junk", () => {
  assert.equal(core.normalizeDeviceProxy("172.18.0.2:20011"), "172.18.0.2:20011");
  assert.equal(core.normalizeDeviceProxy("http://172.18.0.2:20011/"), "172.18.0.2:20011");
  assert.equal(core.normalizeDeviceProxy(""), "");
  assert.throws(() => core.normalizeDeviceProxy("socks5://x:1"), /host:port/);
  assert.throws(() => core.normalizeDeviceProxy("host"), /host:port/);
});

test("adb input args for tap / swipe / keys / text", () => {
  assert.deepEqual(core.inputArgs({ type: "tap", x: 10.4, y: 20.6 }), ["input", "tap", 10, 21]);
  assert.deepEqual(core.inputArgs({ type: "swipe", x1: 0, y1: 0, x2: 100, y2: 200 }), ["input", "swipe", 0, 0, 100, 200, 200]);
  assert.deepEqual(core.inputArgs({ type: "key", key: "home" }), ["input", "keyevent", 3]);
  assert.deepEqual(core.inputArgs({ type: "key", key: "66" }), ["input", "keyevent", 66]);
  assert.deepEqual(core.inputArgs({ type: "text", text: "hi there" }), ["input", "text", "'hi%sthere'"]);
  assert.throws(() => core.inputArgs({ type: "text", text: "你好" }), /ASCII/);
  assert.throws(() => core.inputArgs({ type: "nope" }), /unknown input/);
});

test("preload exposes redroidAPI and the IPC channels it uses exist in main", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "panel-preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "redroid-matrix.js"), "utf8");
  assert.match(preload, /exposeInMainWorld\("redroidAPI"/);
  for (const ch of ["list", "create", "start", "stop", "restart", "remove", "screenshot", "input", "set-proxy", "probe-ip", "frida", "apps", "launch", "uninstall", "install", "shell", "defaults"]) {
    assert.match(main, new RegExp(`h\\("redroid:${ch}"`), `main handles redroid:${ch}`);
  }
  const wiring = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "tab-browser-tools.js"), "utf8");
  assert.match(wiring, /redroidMatrix\.installIpc\(findPanelTab\)/);
});

test("persistent shell session runs commands serially and reports exit codes", async (t) => {
  const { ShellSession } = require("../src/tabbrowser/redroid-shell");
  const s = new ShellSession({ spawnArgs: () => ["bash", ["--norc", "--noprofile"]], label: "t" });
  t.after(() => s.dispose());
  const [a, b] = await Promise.all([s.run("echo one; echo two"), s.run("printf 'no-newline'")]);
  assert.equal(a.stdout, "one\ntwo\n"); // trailing newline kept, same as execFile
  assert.equal(b.stdout, "no-newline");
  await assert.rejects(s.run("echo oops >&2; exit 3"), (e) => e.code === 3 && /oops/.test(e.stdout));
  assert.equal((await s.run("echo still-alive")).stdout.trim(), "still-alive");
  await assert.rejects(s.run("sleep 5", { timeout: 300 }), /timeout/);
  assert.equal((await s.run("echo respawned")).stdout.trim(), "respawned"); // session respawns after a kill
});

test("egress IP classification grades residential / backbone / datacenter / flagged", () => {
  const g = (ipapi, ipapis) => core.classifyIp({ ipapi, ipapis }).grade;
  assert.equal(g({ isp: "Comcast Cable Communications" }, { is_datacenter: false }), "A");
  assert.equal(g({ mobile: true, hosting: false }, null), "A");
  assert.equal(g({ isp: "Cogent Communications" }, { is_datacenter: false }), "B");
  assert.equal(g({ isp: "Thunderbox Inc", hosting: false }, { is_datacenter: true }), "C");
  assert.equal(g({ isp: "Comcast", proxy: true }, null), "D");
  assert.equal(g({}, { is_vpn: true }), "D");
  assert.deepEqual(core.classifyIp({ ipapi: { proxy: true, hosting: true } }).flags, { proxy: true, vpn: false, tor: false, abuser: false, datacenter: true, mobile: false });
});
