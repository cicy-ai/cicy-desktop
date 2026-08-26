const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const protect = require("../src/sidecar/docker-protect");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-protect-"));
  return path.join(dir, "docker-protect.json");
}

test("defaults to protected when no flag file and no env", () => {
  assert.equal(protect.isProtected({ env: {}, file: tmpFile() }), true);
});

test("env CICY_DOCKER_PROTECT=0 disables, flag file persists choice", () => {
  const file = tmpFile();
  assert.equal(protect.isProtected({ env: { CICY_DOCKER_PROTECT: "0" }, file }), false);
  protect.setProtected(false, { file });
  assert.equal(protect.isProtected({ env: {}, file }), false);
  protect.setProtected(true, { file });
  assert.equal(protect.isProtected({ env: {}, file }), true);
  // env 优先于文件
  assert.equal(protect.isProtected({ env: { CICY_DOCKER_PROTECT: "1" }, file: tmpFile() }), true);
});

test("decide blocks automatic destructive actions but allows force", () => {
  const opts = { env: {}, file: tmpFile() };
  assert.equal(protect.decide("recreate", { opts }).allowed, false);
  assert.equal(protect.decide("recreate", { force: true, opts }).allowed, true);
  const off = { env: { CICY_DOCKER_PROTECT: "off" }, file: tmpFile() };
  assert.equal(protect.decide("recreate", { opts: off }).allowed, true);
});

test("guard logs a warning when blocking", () => {
  const warns = [];
  const log = { warn: (m) => warns.push(m) };
  assert.equal(protect.guard(log, "wsl --shutdown", { opts: { env: {}, file: tmpFile() } }), false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /docker-protect/);
});
