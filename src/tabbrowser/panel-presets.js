const PRESETS = {
  "telegram-matrix": { preset: "telegram-matrix", title: "Telegram 矩阵", query: "preset=telegram-matrix" },
};

function resolvePanelPreset(value) {
  return PRESETS[String(value || "")] || { preset: "blank", title: "面板" };
}

module.exports = { resolvePanelPreset };
