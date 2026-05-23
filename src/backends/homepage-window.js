// Homepage window — primary CiCy Desktop window. Singleton; closing it
// does NOT quit the app. The homepage is now a React app built from
// workers/desktop-render and copied to ./homepage-react/.
//
// Override priority:
//   1. CICY_HOMEPAGE_URL env (Vite dev server, e.g. http://localhost:8173)
//   2. ./homepage-react/index.html  (production React build)
//   3. ./homepage.html              (legacy vanilla — kept as fallback)

const path = require("path");
const fs = require("fs");
const { BrowserWindow } = require("electron");

const DEV_URL = process.env.CICY_HOMEPAGE_URL || "";

let homepage = null;

function pickHtml() {
  const reactBuild = path.join(__dirname, "homepage-react", "index.html");
  if (fs.existsSync(reactBuild)) return reactBuild;
  return path.join(__dirname, "homepage.html");
}

function openHomepage() {
  if (homepage && !homepage.isDestroyed()) {
    if (homepage.isMinimized()) homepage.restore();
    homepage.show();
    homepage.focus();
    return homepage;
  }
  homepage = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 360,
    minHeight: 480,
    title: "CiCy Desktop",
    backgroundColor: "#0d1117",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "homepage-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (DEV_URL) {
    homepage.loadURL(DEV_URL);
  } else {
    homepage.loadFile(pickHtml());
  }
  homepage.on("closed", () => { homepage = null; });
  return homepage;
}

function isOpen() {
  return !!(homepage && !homepage.isDestroyed());
}

module.exports = { openHomepage, isOpen };
