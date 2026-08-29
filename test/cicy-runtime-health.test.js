const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldSkipCicyUpdate } = require("../src/sidecar/cicy-runtime-health");

test("does not skip an update when the recorded version matches but the platform package is missing", () => {
  assert.equal(shouldSkipCicyUpdate({ latest: "2.3.563", current: "2.3.563", platformReady: false }), false);
});

test("skips an update only when the recorded version matches and the runtime is complete", () => {
  assert.equal(shouldSkipCicyUpdate({ latest: "2.3.563", current: "2.3.563", platformReady: true }), true);
});

const fs = require("node:fs");
const path = require("node:path");
const readSrc = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("platform-ready check covers the real npm layout (<pkg>/node_modules/cicy-code-linux-x64)", () => {
  const src = readSrc("src/sidecar/wsl-docker.js");
  assert.match(src, /\[ -f "\$dest\/node_modules\/\$p\/package\.json" \]/);
});

test("bootstrap never runs the updater when the container is healthy inside (relay problem)", () => {
  const src = readSrc("src/sidecar/wsl-docker.js");
  const i = src.indexOf('begin("wait-health")');
  const block = src.slice(i, i + 3500);
  assert.match(block, /relayBroken = await insideHealthy\(container, port\)/);
  assert.match(block, /else if \(!healthy\) \{[\s\S]*?await update\(/);
  assert.match(block, /fail\(relayBroken \? "relay_unreachable" : "health_timeout"/);
});

test("daemon loop stops re-bootstrapping after the one-shot relay reset", () => {
  const src = readSrc("src/backends/sidecar-ipc.js");
  assert.match(src, /if \(_relayResetDone\) \{[\s\S]*?reason: "relay_unreachable"[\s\S]*?return;/);
});

test("relay still broken after wsl reset → one-shot elevated Windows TCP repair, then auto reboot", () => {
  const d = readSrc("src/sidecar/docker.js");
  assert.match(d, /function elevatedTcpRepair/);
  assert.match(d, /net stop winnat/);
  assert.match(d, /set dynamicport tcp start=49152 num=16384/);
  const s = readSrc("src/backends/sidecar-ipc.js");
  const i = s.indexOf("if (_relayResetDone) {");
  const block = s.slice(i, i + 3000);
  assert.match(block, /appDocker\.elevatedTcpRepair\(/);
  assert.match(block, /_relayMissesAfterRepair >= 3[\s\S]*?scheduleReboot\(90/);
});
