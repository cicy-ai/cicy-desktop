const PRESETS = {
  "telegram-matrix": { preset: "telegram-matrix", title: "Telegram 矩阵", query: "preset=telegram-matrix" },
  "redroid-matrix": { preset: "redroid-matrix", title: "Redroid 矩阵", query: "preset=redroid-matrix" },
  "facebook-matrix": { preset: "facebook-matrix", title: "Facebook 矩阵", query: "preset=facebook-matrix" },
};

function resolvePanelPreset(value) {
  return PRESETS[String(value || "")] || { preset: "blank", title: "面板" };
}

module.exports = { resolvePanelPreset };
