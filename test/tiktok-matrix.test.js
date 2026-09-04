// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("tiktok-matrix preset is registered everywhere the facebook one is", () => {
  const presets = read("src/tabbrowser/panel-presets.js");
  assert.match(presets, /"tiktok-matrix":\s*\{[\s\S]*?preset:\s*"tiktok-matrix"/);
  assert.match(presets, /"tiktok-matrix":\s*\{[\s\S]*?title:\s*"TikTok 矩阵"/);
  assert.match(read("src/tabbrowser/panel-page-router.js"), /"tiktok-matrix": "tiktok-matrix\.html"/);
  assert.match(read("src/tabbrowser/panel-menu-store.js"), /id:\s*"tiktok-matrix",\s*title:\s*"TikTok 矩阵"/);
});

test("tiktok-matrix page targets tiktok and its own cell ids / storage key", () => {
  const html = read("src/tabbrowser/tiktok-matrix.html");
  assert.match(html, /https:\/\/www\.tiktok\.com\//);
  assert.match(html, /tiktok-preview-\$\{idx\}/);
  assert.match(html, /tiktok-matrix-profile/);
  assert.doesNotMatch(html, /facebook/i);
  assert.doesNotMatch(html, /telegram/i);
  assert.match(html, /id="rows"/);
  assert.match(html, /panelAPI\.states/);
});

test("panel-cells detects TikTok identities and lists them on profiles", () => {
  const src = read("src/tabbrowser/panel-cells.js");
  assert.match(src, /tiktokIdentity\.isTiktokUrl\(u\)/);
  assert.match(src, /tiktok: tiktokIdentity\.tiktokIdentityFromProfile\(p\),/);
});

test("tiktok-identity: handle survives, decoys rejected, record shape matches store", () => {
  const t = require("../src/tabbrowser/tiktok-identity");
  assert.equal(t.isTiktokUrl("https://www.tiktok.com/@x"), true);
  assert.equal(t.isTiktokUrl("https://not-tiktok.com.evil.io/"), false);
  const it = t.normalizeTiktokIdentity({ username: "@alice", displayName: "Alice", id: "42" });
  assert.deepEqual(it, { id: "42", username: "alice", displayName: "Alice", phone: "" });
  assert.equal(t.normalizeTiktokIdentity({ id: "0" }), null);
  const rec = t.tiktokLoginRecord({ username: "alice", displayName: "Alice", id: "42" });
  assert.equal(rec.name, "tiktok");
  assert.equal(rec.username, "alice");
  const back = t.tiktokIdentityFromProfile({ logins: [rec] });
  assert.equal(back.username, "alice");
});
