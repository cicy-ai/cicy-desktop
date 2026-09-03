// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// installNow() used shell.openPath() on the NSIS installer. On a machine with
// nobody at the keyboard that is an interactive wizard waiting forever for a
// click; and even when it did install, nothing started the app again, because
// NSIS runAfterFinish does not fire on a /S install. Both together are why an
// unattended node that took an update never came back — observed across most of
// the fleet, each box needing a manual start.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "app-updater.js"), "utf8");
const win = src.slice(src.indexOf("function installWindows"), src.indexOf("function installNow"));

test("windows installs silently instead of opening a wizard nobody can click", () => {
  assert.match(win, /"\$\{installer\}" \/S/);
  const now = src.slice(src.indexOf("function installNow"), src.indexOf("module.exports"));
  assert.match(now, /if \(process\.platform === "win32"\) \{ installWindows\(f\); return; \}/);
  // the interactive path must no longer be what Windows takes
  assert.ok(
    now.indexOf('process.platform === "win32"') < now.indexOf("shell.openPath"),
    "win32 must be handled before the openPath fallback"
  );
});

test("the chain is windowless — no console flashes during an update", () => {
  // Regression: doing this with spawn(detached:true) put a black console on
  // screen counting down for 20s on every update. On Windows `detached` means
  // CREATE_NEW_CONSOLE, which windowsHide cannot suppress, so the runner has to
  // be wscript + a window-style-0 VBS (same trick as writeSourceAutostartVbs).
  assert.match(win, /spawn\("wscript\.exe", \["\/\/B", "\/\/Nologo", vbs\]/);
  assert.match(win, /sh\.Run "\$\{cmd\.replace\(\/"\/g, '""'\)\}", 0, False/);
  assert.match(win, /CreateObject\("WScript\.Shell"\)/);
  assert.doesNotMatch(win, /spawn\(process\.env\.COMSPEC/); // the visible-console version
});

test("the relaunch is part of the same detached chain, so it outlives the app", () => {
  // The installer kills this process; a child in this process group would die
  // with it and the machine would stay down.
  assert.match(win, /detached: true/);
  assert.match(win, /ch\.unref\(\)/);
  assert.match(win, /start "" "\$\{exe\}" --hidden/);
  assert.match(win, /windowsHide: true/);
});

test("the chain is quit → install → settle → relaunch, in that order", () => {
  // Three waits, each load-bearing:
  //  8s  — this process must be GONE before the installer starts. Racing it is
  //        what made installs fail, and a failed install fed the restart loop
  //        that took the fleet down.
  //  20s — let Windows release the replaced files before the new exe runs.
  // No `start` on the installer leg, so cmd blocks until the install finishes.
  assert.doesNotMatch(win, /start "" "\$\{installer\}"/);
  assert.match(win, /timeout \/t 8 \/nobreak >nul & "\$\{installer\}" \/S/);
  assert.match(win, /timeout \/t 20 \/nobreak/);
  const preWait = win.indexOf("timeout /t 8");
  const install = win.indexOf('"${installer}" /S');
  const settle = win.indexOf("timeout /t 20");
  const relaunch = win.indexOf('start "" "${exe}"');
  assert.ok(
    preWait < install && install < settle && settle < relaunch,
    "quit → install → settle → relaunch"
  );
});

test("the app quits promptly, well inside the chain's 8s head start", () => {
  assert.match(win, /app\.quit\(\)/);
  const m = win.match(/\}, (\d+)\);/);
  assert.ok(m, "quit is scheduled");
  assert.ok(Number(m[1]) < 8000, `quit delay ${m[1]}ms must be under the 8s head start`);
});

test("mac and linux keep their existing behaviour", () => {
  const now = src.slice(src.indexOf("function installNow"), src.indexOf("module.exports"));
  assert.match(
    now,
    /if \(process\.platform === "linux"\) \{ shell\.showItemInFolder\(f\); return; \}/
  );
  assert.match(now, /shell\.openPath\(f\)/); // mac pkg still opens the GUI installer
});
