const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("second-instance never steals focus: only surfaces a window when none is visible", () => {
  const main = read("src/main.js");
  const block = main.slice(main.indexOf('electronApp.on("second-instance"'), main.indexOf('electronApp.on("second-instance"') + 1500);
  assert.doesNotMatch(block, /w\.focus\(\)/);
  assert.match(block, /showInactive\(\)/);
});

test("agent-driven tab activate does not bring the window to front", () => {
  const src = read("src/tools/tab-browser-tools.js");
  const i = src.indexOf("const success = m.activate(webContentsId);");
  const block = src.slice(i, i + 600);
  assert.doesNotMatch(block, /m\.win\.focus\(\)|app\.focus\(\{ steal: true \}\)/);
  assert.match(block, /m\.surfaceQuiet\(\)/);
});

test("page-driven opens (window.open / cross-origin navigate) never activate the window", () => {
  const src = read("src/tools/tab-browser-tools.js");
  assert.match(src, /if \(this\.accountIdx === 0\) openTab\(1, u, \{ activate: false \}\)/);
  assert.match(src, /e\.preventDefault\(\);\s*openTab\(1, u, \{ activate: false \}\)/);
});

test("tab windows are created hidden and only surfaced by openTab / a quiet fallback", () => {
  const src = read("src/tools/tab-browser-tools.js");
  const i = src.indexOf("const winOpts = {");
  assert.match(src.slice(i, i + 600), /show: false,/);
  const j = src.indexOf("this.win = new BrowserWindow(winOpts);");
  assert.match(src.slice(j, j + 400), /showInactive\(\)/);
});

test("non-click createWindow paths open in the background", () => {
  assert.match(read("src/utils/window-utils.js"), /createWindow\(\{ url, background: true \}, target, true\)/);
  assert.match(read("src/tools/ipc-bridge.js"), /createWindow\(\{ url, background: true \}, 0, true\)/);
  assert.match(read("src/tools/window-tools.js"), /const opts = \{ url: entry\.url, background: true \}/);
  assert.match(read("src/main.js"), /const opts = \{ url: e\.url, background: true \}/);
});

test("focus audit hooks show/focus/restore/moveTop", () => {
  const main = read("src/main.js");
  assert.match(main, /\[focus-audit\]/);
  assert.match(main, /\["show", "focus", "restore", "moveTop"\]/);
});
