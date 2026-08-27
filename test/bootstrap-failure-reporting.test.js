const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("ensureWsl short-circuits when the desktop cannot spawn child processes", () => {
  const src = read("src/sidecar/docker.js");
  assert.match(src, /async function ensureWsl\([^)]*\) \{\n  const sp = await spawnProbe\(\);/);
  assert.match(src, /reason: "spawn_blocked"/);
});

test("bootstrap failures land in lastError and pause the auto-bootstrap loop until the user retries", () => {
  const src = read("src/backends/sidecar-ipc.js");
  assert.match(src, /HARD_BOOTSTRAP_REASONS = new Set\(\["spawn_blocked", "virtualization_disabled", "wsl_enable_failed"/);
  assert.match(src, /if \(!s\.running && !s\.unknown && _autoBootstrapPaused && Date\.now\(\) < _autoBootstrapRetryAt\)/);
  assert.match(src, /"docker:app-bootstrap"[^]*_autoBootstrapPaused = null;[^]*recordBootstrapResult\(result\)/);
  assert.match(src, /catch \(err\) \{\n      recordBootstrapResult\(null, err\);/);
  assert.match(src, /logFile: _logFile/);
});

test("featureEnabled reads Win32_OptionalFeature (works unelevated), dism only as fallback", () => {
  const src = read("src/sidecar/docker.js");
  assert.match(src, /Get-CimInstance Win32_OptionalFeature -Filter "Name='\$\{feature\}'"\)\.InstallState/);
  assert.match(src, /resolve\(v === "1"\)/);
});

test("wsl --import failures carry wsl.exe's decoded message into the drawer", () => {
  const src = read("src/sidecar/wsl-docker.js");
  assert.match(src, /encoding: "buffer"/);
  assert.match(src, /se\.toString\("utf16le"\)/);
});

test("keepalive logon task degrades to LeastPrivilege / HKCU Run when not elevated", () => {
  const src = read("src/sidecar/wsl-docker.js");
  assert.match(src, /writeKeepaliveFiles\(\{ runLevel: "LeastPrivilege" \}\)/);
  assert.match(src, /CurrentVersion\\\\Run/);
});

test("a second bootstrap caller gets the in-flight run's progress (replay + live)", () => {
  const src = read("src/sidecar/wsl-docker.js");
  assert.match(src, /for \(const ev of _bootstrapRecent\) \{ try \{ opts\.onProgress\(ev\); \} catch \{\} \}\n\s+_bootstrapListeners\.add\(opts\.onProgress\);/);
  assert.match(src, /for \(const fn of _bootstrapListeners\) \{ try \{ fn\(ev\); \} catch \{\} \}/);
});
