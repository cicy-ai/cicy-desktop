// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// preset id → what the tab actually opens. This table stays authoritative for
// WHICH page a preset maps to (panel-page-router needs a real page behind every
// id); the user-configurable part is only the display name, which comes from
// panel-menu-store so a renamed menu entry shows the same name on its tab.
const store = require("./panel-menu-store");

const PRESETS = {
  "telegram-matrix": {
    preset: "telegram-matrix",
    title: "Telegram 矩阵",
    query: "preset=telegram-matrix",
  },
  "redroid-matrix": {
    preset: "redroid-matrix",
    title: "Redroid 矩阵",
    query: "preset=redroid-matrix",
  },
  "facebook-matrix": {
    preset: "facebook-matrix",
    title: "Facebook 矩阵",
    query: "preset=facebook-matrix",
  },
};

function resolvePanelPreset(value) {
  const key = String(value || "");
  const base = PRESETS[key];
  if (!base) return { preset: "blank", title: store.titleFor("blank") || "面板" };
  return { ...base, title: store.titleFor(key) || base.title };
}

module.exports = { resolvePanelPreset };
