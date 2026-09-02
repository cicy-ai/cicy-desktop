// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Windows autostart had no test and never worked. Measured across the fleet:
// app.setLoginItemSettings({openAtLogin:true}) returns without throwing, yet
// getLoginItemSettings() still reports false and HKCU\...\Run stays untouched
// (the key exists and is writable — OneDrive lives there). So every Windows node
// ran with no autostart at all, which is why one whose app went away never came
// back, not even after a reboot. ensureAutoLaunch() now reads the setting back
// and owns the Run entry itself when the API did not take.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
const fn = src.slice(
  src.indexOf("function ensureAutoLaunch()"),
  src.indexOf("function ensureWindowsRunKey")
);

test("windows autostart verifies the setting instead of trusting the API", () => {
  // A single getLoginItemSettings() call before the write is not enough — the
  // regression is entirely in what happens AFTER setLoginItemSettings().
  assert.match(fn, /const probe = \(\) =>/);
  assert.match(fn, /if \(probe\(\)\.openAtLogin !== want\) \{[^]*setLoginItemSettings\(opts\)/);
  assert.match(fn, /if \(probe\(\)\.openAtLogin !== want\) ensureWindowsRunKey\(want, runCmd\)/);
});

test("the Run-key command differs for packaged vs source runs", () => {
  // Packaged: the exe itself, hidden. Source: wscript running the VBS launcher,
  // because starting electron.exe directly skips bin/cicy-desktop's master boot.
  assert.match(fn, /runCmd = `"\$\{process\.execPath\}" --hidden`/);
  assert.match(fn, /runCmd = `wscript\.exe \/\/B \/\/Nologo "\$\{vbs\}"`/);
});

test("ensureWindowsRunKey adds or removes the HKCU Run value, async and non-fatal", () => {
  const helper = src.slice(
    src.indexOf("function ensureWindowsRunKey"),
    src.indexOf("// 源码模式 Windows 登录自启")
  );
  assert.match(
    src,
    /WIN_RUN_KEY = "HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run"/
  );
  assert.match(
    helper,
    /\["add", WIN_RUN_KEY, "\/v", WIN_RUN_NAME, "\/t", "REG_SZ", "\/d", command, "\/f"\]/
  );
  assert.match(helper, /\["delete", WIN_RUN_KEY, "\/v", WIN_RUN_NAME, "\/f"\]/);
  assert.match(helper, /execFile\("reg", args, \{ windowsHide: true \}/); // no console flash, no startup stall
  assert.match(helper, /catch \(e\) \{[^]*log\.warn/); // best-effort: never throws into startup
});

test("autostart still defaults to on and is honoured per-platform", () => {
  assert.match(fn, /const want = prefs\.openAtLogin !== false/);
  assert.match(fn, /if \(process\.platform === "darwin"\)/);
  assert.match(fn, /else if \(process\.platform === "linux"\)/);
});
