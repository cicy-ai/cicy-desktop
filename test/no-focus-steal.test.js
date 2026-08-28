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
