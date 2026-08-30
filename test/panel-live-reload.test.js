const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// Stub electron so the module loads under plain node.
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "electron") return { app: { isPackaged: false }, webContents: { getAllWebContents: () => stubWcs } };
  return origLoad.call(this, req, ...rest);
};
let stubWcs = [];
const live = require("../src/tabbrowser/panel-live-reload");
Module._load = origLoad;

test("presetsForFile maps page files to presets", () => {
  assert.deepStrictEqual(live.presetsForFile("telegram-matrix.html"), ["telegram-matrix"]);
  assert.deepStrictEqual(live.presetsForFile("split-panel.html"), [""]);
  assert.deepStrictEqual(live.presetsForFile("panel-cells.js"), []);
});

test("presetOf reads the preset off cicyui://panel URLs only", () => {
  assert.strictEqual(live.presetOf({ getURL: () => "cicyui://panel/abc?preset=telegram-matrix" }), "telegram-matrix");
  assert.strictEqual(live.presetOf({ getURL: () => "cicyui://panel/abc" }), "");
  assert.strictEqual(live.presetOf({ getURL: () => "https://web.telegram.org/" }), null);
});

test("reloadPreset reloads only matching, live views", () => {
  const mk = (url, destroyed = false) => { const o = { hits: 0, isDestroyed: () => destroyed, getURL: () => url, reloadIgnoringCache() { o.hits++; } }; return o; };
  const tg = mk("cicyui://panel/1?preset=telegram-matrix");
  const fb = mk("cicyui://panel/2?preset=facebook-matrix");
  const dead = mk("cicyui://panel/3?preset=telegram-matrix", true);
  const site = mk("https://web.telegram.org/k/");
  stubWcs = [tg, fb, dead, site];
  assert.strictEqual(live.reloadPreset(["telegram-matrix"], { info() {} }), 1);
  assert.deepStrictEqual([tg.hits, fb.hits, dead.hits, site.hits], [1, 0, 0, 0]);
});

test("enabled honours CICY_PANEL_LIVE_RELOAD override", () => {
  const prev = process.env.CICY_PANEL_LIVE_RELOAD;
  process.env.CICY_PANEL_LIVE_RELOAD = "0"; assert.strictEqual(live.enabled(), false);
  process.env.CICY_PANEL_LIVE_RELOAD = "1"; assert.strictEqual(live.enabled(), true);
  delete process.env.CICY_PANEL_LIVE_RELOAD; assert.strictEqual(live.enabled(), true); // unpackaged stub
  if (prev !== undefined) process.env.CICY_PANEL_LIVE_RELOAD = prev;
});
