const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("facebook-matrix preset is registered everywhere the telegram one is", () => {
  const presets = read("src/tabbrowser/panel-presets.js");
  assert.match(presets, /"facebook-matrix":\s*\{[\s\S]*?preset:\s*"facebook-matrix"/);
  assert.match(presets, /"facebook-matrix":\s*\{[\s\S]*?title:\s*"Facebook 矩阵"/);
  assert.match(read("src/tabbrowser/panel-page-router.js"), /"facebook-matrix": "facebook-matrix\.html"/);
  // The dropdown is no longer a hard-coded array in panel-menu.js — entries are
  // registered in panel-menu-store's built-in list, which the homepage then
  // reorders/renames/disables. Registration lives there now.
  assert.match(
    read("src/tabbrowser/panel-menu-store.js"),
    /id:\s*"facebook-matrix",\s*title:\s*"Facebook 矩阵"/
  );
});

test("facebook-matrix page targets facebook and its own cell ids / storage key", () => {
  const html = read("src/tabbrowser/facebook-matrix.html");
  assert.match(html, /https:\/\/www\.facebook\.com\//);
  assert.match(html, /facebook-preview-\$\{idx\}/);
  assert.match(html, /facebook-matrix-profile/);
  assert.doesNotMatch(html, /telegram/i);
  assert.match(html, /id="rows"/);
  assert.match(html, /panelAPI\.states/);
});

test("panel-cells detects Facebook identities and lists them on profiles", () => {
  const src = read("src/tabbrowser/panel-cells.js");
  assert.match(src, /facebookIdentity\.isFacebookUrl\(u\)/);
  assert.match(src, /facebook: facebookIdentity\.facebookIdentityFromProfile\(p\),/);
});
