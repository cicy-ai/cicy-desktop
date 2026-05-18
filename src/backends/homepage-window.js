// Homepage window — primary CiCy Desktop window. Singleton; closing it
// does NOT quit the app. During UI iteration set CICY_HOMEPAGE_URL to a
// Vite dev URL (e.g. https://g-8173.cicy-ai.com/) so refreshes happen
// without rebuilding the .app; packaged production builds fall through to
// the bundled homepage.html.

const path = require("path");
const { BrowserWindow } = require("electron");

const DEV_URL = process.env.CICY_HOMEPAGE_URL || "";

let homepage = null;

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
    minWidth: 760,
    minHeight: 520,
    title: "CiCy Desktop",
    backgroundColor: "#0f1115",
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
    homepage.loadFile(path.join(__dirname, "homepage.html"));
  }
  homepage.on("closed", () => { homepage = null; });
  return homepage;
}

function isOpen() {
  return !!(homepage && !homepage.isDestroyed());
}

module.exports = { openHomepage, isOpen };
