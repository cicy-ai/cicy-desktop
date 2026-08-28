const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("facebook-matrix preset is registered everywhere the telegram one is", () => {
  assert.match(read("src/tabbrowser/panel-presets.js"), /"facebook-matrix": \{ preset: "facebook-matrix", title: "Facebook 矩阵"/);
  assert.match(read("src/tabbrowser/panel-page-router.js"), /"facebook-matrix": "facebook-matrix\.html"/);
  assert.match(read("src/tabbrowser/panel-menu.js"), /label: "Facebook 矩阵"/);
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
  assert.match(src, /facebookIdentity\.isFacebookUrl\(url\)/);
  assert.match(src, /facebook: facebookIdentity\.facebookIdentityFromProfile\(p\),/);
});
