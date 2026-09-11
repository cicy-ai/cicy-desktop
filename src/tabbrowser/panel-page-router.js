// preset=<name> on a cicyui://panel URL picks the page file; anything else is
// the generic split panel.
const PAGES = {
  // 合并后的矩阵页。漏了这一项的话 preset=matrix 会掉回 split-panel.html,
  // 面板重载时就不是矩阵了。
  matrix: "matrix.html",
  "telegram-matrix": "telegram-matrix.html",
  "redroid-matrix": "redroid-matrix.html",
  "facebook-matrix": "facebook-matrix.html",
  "tiktok-matrix": "tiktok-matrix.html",
};

function panelPageForUrl(value) {
  try {
    return PAGES[new URL(value).searchParams.get("preset")] || "split-panel.html";
  } catch (e) {
    return "split-panel.html";
  }
}

module.exports = { panelPageForUrl, PAGES };
