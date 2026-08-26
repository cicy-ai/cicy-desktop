const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("wsl-docker guards every automatic destructive path with docker-protect", () => {
  const src = read("src/sidecar/wsl-docker.js");
  assert.match(src, /require\("\.\/docker-protect"\)/);
  // runContainer: rm -f only after the protect guard
  assert.match(src, /protect\.guard\(log, `docker rm -f \$\{container\}/);
  // recreate / upgrade need force
  assert.match(src, /protect\.guard\(log, `recreate \$\{container\}`, \{ force \}\)/);
  assert.match(src, /protect\.guard\(log, "upgrade \(stop \+ wsl --unregister\)", \{ force \}\)/);
  // bootstrap: no wsl --shutdown / distro reset / auto-update when protected
  assert.match(src, /protect\.guard\(log, "zombie-8008 → wsl --shutdown"\)/);
  assert.match(src, /protect\.guard\(log, "reset-broken-distro \(wsl --unregister\)"\)/);
  assert.match(src, /startEngine\(\{ emit, noShutdown: protect\.isProtected\(\) \}\)/);
  assert.match(src, /protect\.guard\(log, "auto-update after health miss"\)/);
});

test("sidecar-ipc: self-heal is disabled under protection and user actions pass force", () => {
  const src = read("src/backends/sidecar-ipc.js");
  assert.match(src, /appDocker\.hasGatewayKey && dockerProtect\.isProtected\(\)/);
  const forced = (src.match(/force: true/g) || []).length;
  assert.ok(forced >= 4, `expected recreate/upgrade/set-ports/set-dood to pass force:true, got ${forced}`);
});

test("WSL logon task keeps the distro alive so dockerd survives", () => {
  const src = read("src/sidecar/wsl-docker.js");
  assert.match(src, /start-dockerd\.sh; exec flock -n \/run\/cicy-keepalive\.lock sleep infinity/);
  assert.match(src, /<Hidden>true<\/Hidden>/);
  assert.match(src, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(src, /wscript\.exe/);
  assert.match(src, /command=\/usr\/local\/sbin\/start-dockerd\.sh/);
});
