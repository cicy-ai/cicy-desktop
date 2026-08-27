const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "app-updater.js"), "utf8");
const jsx = fs.readFileSync(path.join(__dirname, "..", "workers", "render", "src", "App.jsx"), "utf8");
const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "backends", "ipc.js"), "utf8");

test("auto-update flag is persisted in global.json and drives check()", () => {
  assert.match(src, /desktopAutoUpdate: v/);
  assert.match(src, /if \(getAutoUpdate\(\)\) \{[^]*await downloadUpdate\(\);[^]*installNow\(\)/);
  assert.match(src, /getAutoUpdate, setAutoUpdate/);
  assert.match(ipc, /"app:auto-update-set"/);
});

test("update modal offers the auto-update checkbox", () => {
  assert.match(jsx, /data-id="UpdateBanner-auto"/);
  assert.match(jsx, /setAutoUpdate\?\.\(on\)/);
});
