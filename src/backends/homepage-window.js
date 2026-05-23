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
  // Pipe renderer console + load failures to main-process stdout so we can
  // diagnose blank-page bugs from logs without opening DevTools.
  homepage.webContents.on("console-message", (_e, level, msg, line, source) => {
    if (level >= 1) console.log(`[homepage:console L${line}] ${msg}  (${source})`);
  });
  homepage.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[homepage] did-fail-load ${code} ${desc} ${url}`);
  });
  homepage.on("closed", () => { homepage = null; });
  return homepage;
}

function isOpen() {
  return !!(homepage && !homepage.isDestroyed());
}

module.exports = { openHomepage, isOpen, getHomepageWindow: () => homepage };
