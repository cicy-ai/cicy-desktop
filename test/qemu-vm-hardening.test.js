const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CTL = path.join(__dirname, "..", "src", "sidecar", "qemu-vm.cjs");

// qemu-vm.cjs 是命令行脚本:给它一个临时 HOME,伪造「虚拟机在跑」(qemu.pid 指向测试进程自己)和控制台日志。
function ctlStatus(consoleText) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vmctl-"));
  const vm = path.join(home, "cicy-ai", "vm", "debian"), logs = path.join(home, "cicy-ai", "logs");
  fs.mkdirSync(vm, { recursive: true }); fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(vm, "qemu.pid"), String(process.pid));
  fs.writeFileSync(path.join(logs, "debian-console.log"), consoleText);
  const out = execFileSync(process.execPath, [CTL, "status"], { env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "lad") }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

test("a guest kernel Oops in the console is reported as crashed (2026-10-23 IDE PIO crash)", () => {
  const s = ctlStatus("[    7.4] systemd[1]: Started cicy-ttyd.service\n[99293.49] Oops: Bad pagetable: 0008 [#1] PREEMPT SMP PTI\n[99293.50] Call Trace:\n");
  assert.strictEqual(s.running, true);
  assert.match(s.crashed, /Oops: Bad pagetable/);
});

test("an RCU stall (hung guest) is reported as crashed", () => {
  assert.match(ctlStatus("[33268.26] rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:\n").crashed, /rcu_preempt detected stalls/);
});

test("a normal boot log is not a crash", () => {
  assert.strictEqual(ctlStatus("[    1.0] Linux version 6.12\n[    7.4] systemd[1]: Reached target multi-user.target\n").crashed, "");
});

test("the VM launch line drops QEMU's default devices (no IDE CD-ROM)", () => {
  assert.match(fs.readFileSync(CTL, "utf8"), /"-nodefaults",/);
});

test("fleetName: global.json desktopTeam without the desktop- prefix, else hostname", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleetname-"));
  fs.mkdirSync(path.join(home, "cicy-ai"), { recursive: true });
  const saved = os.homedir; os.homedir = () => home;
  try {
    delete require.cache[require.resolve("../src/sidecar/qemu-docker")];
    const qd = require("../src/sidecar/qemu-docker");
    fs.writeFileSync(path.join(home, "cicy-ai", "global.json"), JSON.stringify({ desktopTeam: "desktop-xs-1003" }));
    assert.strictEqual(qd.fleetName(), "xs-1003");
    fs.writeFileSync(path.join(home, "cicy-ai", "global.json"), JSON.stringify({}));
    assert.strictEqual(qd.fleetName(), os.hostname().split(".")[0]);
  } finally { os.homedir = saved; }
});
