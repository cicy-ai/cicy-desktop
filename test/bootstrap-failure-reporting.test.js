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
  assert.match(src, /toString\("utf16le"\)/);
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

test("WSL setup is a single elevation with component-store repair fallback; reboot is scheduled automatically", () => {
  const d = read("src/sidecar/docker.js");
  assert.match(d, /function elevatedWslSetup\(/);
  assert.match(d, /restorehealth/);
  assert.match(d, /const r = await elevatedWslSetup\(\{ emit, need:/);
  assert.match(d, /function wslExe\(\)/);
  assert.doesNotMatch(d, /execFile\("wsl", \[/);
  assert.doesNotMatch(read("src/sidecar/wsl-docker.js"), /(execFile|spawn)\("wsl", \[/);
  const ipc = read("src/backends/sidecar-ipc.js");
  assert.match(ipc, /reason === "wsl_reboot_required"\) scheduleReboot\(90\)/);
  assert.match(ipc, /"docker:reboot-cancel"/);
  assert.match(read("workers/render/src/App.jsx"), /DockerDrawer-reboot-cancel/);
});

test("auto-update defaults to on", () => {
  assert.match(read("src/app-updater.js"), /desktopAutoUpdate !== false/);
});

test("a missing wsl.exe (ENOENT, features enabled but not yet rebooted) counts as WSL missing", () => {
  assert.match(read("src/sidecar/docker.js"), /err\.code === "ENOENT"[^\n]*return resolve\(true\)/);
});

test("features enabled but WSL still the pre-reboot stub → needsReboot; auto-reboot capped at 2", () => {
  const d = read("src/sidecar/docker.js");
  assert.match(d, /if \(!\(await wslFunctional\(\)\)\) \{/);
  assert.match(d, /\[Argument\\\]/);
  const ipc = read("src/backends/sidecar-ipc.js");
  assert.match(ipc, /rebootCount\(\) >= 2/);
});

test("missing WSL2 kernel is installed through the same single elevation", () => {
  const d = read("src/sidecar/docker.js");
  assert.match(d, /function wslKernelPresent\(\)/);
  assert.match(d, /if \(!wslKernelPresent\(\)\) \{[^]*elevatedWslSetup\(\{ emit, need: \{\} \}\)/);
  assert.match(d, /reason: "wsl_kernel_missing"/);
});
