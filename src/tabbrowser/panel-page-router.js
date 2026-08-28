// preset=<name> on a cicyui://panel URL picks the page file; anything else is
// the generic split panel.
const PAGES = {
  "telegram-matrix": "telegram-matrix.html",
  "redroid-matrix": "redroid-matrix.html",
  "facebook-matrix": "facebook-matrix.html",
};

function panelPageForUrl(value) {
  try {
    return PAGES[new URL(value).searchParams.get("preset")] || "split-panel.html";
  } catch (e) {
    return "split-panel.html";
  }
}

module.exports = { panelPageForUrl, PAGES };
