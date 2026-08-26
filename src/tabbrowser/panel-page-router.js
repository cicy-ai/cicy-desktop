function panelPageForUrl(value) {
  try {
    return new URL(value).searchParams.get("preset") === "telegram-matrix"
      ? "telegram-matrix.html"
      : "split-panel.html";
  } catch (e) {
    return "split-panel.html";
  }
}

module.exports = { panelPageForUrl };
