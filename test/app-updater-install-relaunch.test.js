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

test("the chain waits for the installer before relaunching", () => {
  // No `start` on the installer leg → cmd blocks on it; then a pause so Windows
  // releases the replaced files before the new exe runs.
  assert.doesNotMatch(win, /start "" "\$\{installer\}"/);
  assert.match(win, /timeout \/t 20 \/nobreak/);
  const order = [win.indexOf("/S"), win.indexOf("timeout /t"), win.indexOf('start "" "${exe}"')];
  assert.ok(order[0] < order[1] && order[1] < order[2], "install → wait → relaunch, in that order");
});

test("the app quits so the installer can replace its files", () => {
  assert.match(win, /app\.quit\(\)/);
  assert.match(win, /setTimeout\(\(\) => \{ try \{ app\.quit\(\); \} catch \{\} \}, 1500\)/);
});

test("mac and linux keep their existing behaviour", () => {
  const now = src.slice(src.indexOf("function installNow"), src.indexOf("module.exports"));
  assert.match(
    now,
    /if \(process\.platform === "linux"\) \{ shell\.showItemInFolder\(f\); return; \}/
  );
  assert.match(now, /shell\.openPath\(f\)/); // mac pkg still opens the GUI installer
});
