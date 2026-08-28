const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolvePanelPreset } = require("../src/tabbrowser/panel-presets");
const { createPanelMenuTemplate } = require("../src/tabbrowser/panel-menu");

test("telegram matrix preset creates an empty panel with the requested title", () => {
  assert.deepEqual(resolvePanelPreset("telegram-matrix"), {
    preset: "telegram-matrix",
    title: "Telegram 矩阵",
    query: "preset=telegram-matrix",
  });
});

test("panel menu offers blank panel and Telegram matrix actions", () => {
  const opened = [];
  const template = createPanelMenuTemplate((preset) => opened.push(preset));

  assert.deepEqual(template.map((item) => item.label), ["面板", "Telegram 矩阵", "Redroid 矩阵", "Facebook 矩阵"]);
  template[0].click();
  template[1].click();
  template[2].click();
  assert.deepEqual(opened, ["blank", "telegram-matrix", "redroid-matrix"]);
});

test("the panel plus button opens a native menu that cannot be covered by BrowserViews", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "tab-shell.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "tab-shell-preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "tab-browser-tools.js"), "utf8");

  assert.doesNotMatch(html, /id="panelmenu"/);
  assert.match(html, /openPanelMenu\(\)/);
  assert.match(preload, /tabwin:panel-menu/);
  assert.match(main, /Menu\.buildFromTemplate/);
});
