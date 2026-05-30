// Homepage window — primary CiCy Desktop window. Singleton; closing it
// does NOT quit the app.
//
// URL selection:
//   1. CICY_HOMEPAGE_URL env (Vite dev server) — wins everywhere if set;
//      if the URL fails to load (tunnel down, server not running) the window
//      automatically falls back to the local file:// SPA.
//   2. Windows: remote https://desktop.cicy-ai.com — keeps Win shipping
//      without rebuilding (Win release cadence is slower than render's)
//   3. Mac/Linux: bundled local SPA file:// — works offline, no mixed-
//      content concerns when embedding the team-assistant webview
//      (the cicy-desktop preload's IPC bridge still attaches).

const path = require("path");
const { BrowserWindow } = require("electron");
const log = require("electron-log");

const REMOTE_URL = "https://desktop.cicy-ai.com/";
const DEV_URL = process.env.CICY_HOMEPAGE_URL || "";
const LOCAL_INDEX = path.join(__dirname, "homepage-react", "index.html");

function pickHomepageURL() {
  if (DEV_URL) return DEV_URL;
  if (process.platform === "win32") return REMOTE_URL;
  return `file://${LOCAL_INDEX}`;
}

let homepage = null;

async function openHomepage() {
  if (homepage && !homepage.isDestroyed()) {
    if (homepage.isMinimized()) homepage.restore();
    homepage.show();
    homepage.focus();
    return homepage;
  }
  homepage = new BrowserWindow({
    width: 1320,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    title: "CiCy Desktop",
    backgroundColor: "#0d1117",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Auto-hide the native menu bar on win/linux. The bar reappears when
    // the user presses Alt; otherwise the SPA's own topbar is the only
    // chrome the user sees.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "homepage-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Embed the 团队助手 right-drawer (helper SPA at http://43.99.56.150:8011/).
      // webviewTag enables <webview> in the renderer; allowRunningInsecureContent
      // lets the HTTPS homepage load the HTTP helper as a child resource.
      // Without these the renderer's drawer either has no webview element at
      // all (webviewTag default false) or its iframe loads chrome-error://
      // due to mixed-content blocking.
      webviewTag: true,
      allowRunningInsecureContent: true,
    },
  });

  // Mac hiddenInset titlebar overlays the traffic-light buttons into the
  // window content area, so the renderer needs to reserve ~78px on the left
  // of its topbar. In fullscreen the buttons hide and we want that gutter
  // back. Emit window:fullscreen → renderer toggles a data-attr → CSS swaps
  // the padding.
  homepage.on("enter-full-screen", () => {
    try { homepage.webContents.send("window:fullscreen", true); } catch {}
  });
  homepage.on("leave-full-screen", () => {
    try { homepage.webContents.send("window:fullscreen", false); } catch {}
  });

  const target = pickHomepageURL();
  log.info(`[homepage] loading ${target}`);
  homepage.loadURL(target);

  // Pipe renderer console + load failures to main-process stdout so we can
  // diagnose blank-page bugs from logs without opening DevTools.
  homepage.webContents.on("console-message", (_e, level, msg, line, source) => {
    if (level >= 1) console.log(`[homepage:console L${line}] ${msg}  (${source})`);
  });
  // If the dev URL (Vite / SSH tunnel) is unreachable, fall back to the
  // local bundled file:// SPA so the window never stays blank.
  homepage.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[homepage] did-fail-load ${code} ${desc} ${url}`);
    const fallback = `file://${LOCAL_INDEX}`;
    if (url && DEV_URL && url.startsWith(DEV_URL.replace(/\/$/, "")) && url !== fallback) {
      log.warn(`[homepage] dev URL unreachable, falling back to ${fallback}`);
      homepage.loadURL(fallback);
    }
  });
  homepage.on("closed", () => { homepage = null; });
  return homepage;
}

function isOpen() {
  return !!(homepage && !homepage.isDestroyed());
}

module.exports = { openHomepage, isOpen, getHomepageWindow: () => homepage };
