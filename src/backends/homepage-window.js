// Homepage window — primary CiCy Desktop window. Singleton; closing it
// does NOT quit the app. The homepage is the React SPA hosted on
// https://desktop.cicy-ai.com — we always load it remotely so UI changes
// ship without rebuilding cicy-desktop.
//
// URL priority:
//   1. CICY_HOMEPAGE_URL env (Vite dev server, e.g. http://localhost:8173)
//   2. https://desktop.cicy-ai.com (production)
//
// No local fallback — if the remote URL is unreachable, the window will
// surface the error so the user knows to check connectivity.

const path = require("path");
const { BrowserWindow } = require("electron");
const log = require("electron-log");

const REMOTE_URL = "https://desktop.cicy-ai.com/";
const DEV_URL = process.env.CICY_HOMEPAGE_URL || "";

let homepage = null;

async function openHomepage() {
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

  const target = DEV_URL || REMOTE_URL;
  log.info(`[homepage] loading ${target}`);
  homepage.loadURL(target);

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
