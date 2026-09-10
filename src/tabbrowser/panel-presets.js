// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// preset id → what the tab actually opens. This table stays authoritative for
// WHICH page a preset maps to (panel-page-router needs a real page behind every
// id); the user-configurable part is only the display name, which comes from
// panel-menu-store so a renamed menu entry shows the same name on its tab.
const store = require("./panel-menu-store");

const PRESETS = {
  // 三个社媒矩阵已合并成一个页面(matrix.html):一个 profile 带一个 type,
  // 同一个网格按 type 决定每格加载什么。
  matrix: {
    preset: "matrix",
    title: "矩阵",
    query: "preset=matrix",
  },
  // 老 id 保留并映射到合并页 —— 有人的 panel-menu.json / 已保存的标签还存着它们,
  // 点了不能没反应。标题也统一成「矩阵」,不然标签页还写着「Telegram 矩阵」。
  "telegram-matrix": {
    preset: "matrix",
    title: "矩阵",
    query: "preset=matrix",
  },
  "facebook-matrix": {
    preset: "matrix",
    title: "矩阵",
    query: "preset=matrix",
  },
  "tiktok-matrix": {
    preset: "matrix",
    title: "矩阵",
    query: "preset=matrix",
  },
  "redroid-matrix": {
    preset: "redroid-matrix",
    title: "Redroid 矩阵",
    query: "preset=redroid-matrix",
  },
};

function resolvePanelPreset(value) {
  const key = String(value || "");
  const base = PRESETS[key];
  if (!base) return { preset: "blank", title: store.titleFor("blank") || "面板" };
  return { ...base, title: store.titleFor(key) || base.title };
}

module.exports = { resolvePanelPreset };
