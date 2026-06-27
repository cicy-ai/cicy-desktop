// Homepage window — primary CiCy Desktop window. Singleton; closing it
// does NOT quit the app.
//
// URL selection (HARDCODED — no env/dev-URL switch, no Vite, no remote): ALL
// platforms load the bundled local file:// SPA — works offline, fast, no
// remote dependency, no mixed-content concerns when embedding the
// team-assistant webview (the cicy-desktop preload's IPC bridge still
// attaches).

const path = require("path");
const { BrowserWindow } = require("electron");
const log = require("electron-log");

// Fixed homepage window size (写死 930*640, 不能 resize).
const FIXED_WIDTH = 930;
const FIXED_HEIGHT = 640;

const LOCAL_INDEX = path.join(__dirname, "homepage-react", "index.html");

function pickHomepageURL() {
  return `file://${LOCAL_INDEX}`;
}

let homepage = null;    // standalone fallback window (only if the tab engine fails)
let homeTabWc = null;   // the homepage's resident-tab webContents (primary path)

// Primary entry: the homepage is the RESIDENT first tab of profile 0's tab
// browser window (homepage = profile 0 的起始页). Clicking a team there
// opens the team as another tab in the same window. Falls back to a standalone
// window only if the tab engine throws, so the homepage is never unreachable.
async function openHomepage() {
  try {
    const tabBrowser = require("../tools/tab-browser-tools");
    const { win, wc } = tabBrowser.openHomeWindow(0, pickHomepageURL());
    if (wc) {
      homeTabWc = wc;
      try { wc.once("destroyed", () => { if (homeTabWc === wc) homeTabWc = null; }); } catch {}
    }
    log.info(`[homepage] opened as profile-0 resident tab (wc=${wc && wc.id})`);
    return win;
  } catch (e) {
    log.warn(`[homepage] tab route failed (${e.message}); using standalone window`);
    return openHomepageStandalone();
  }
}

async function openHomepageStandalone() {
  if (homepage && !homepage.isDestroyed()) {
    if (homepage.isMinimized()) homepage.restore();
    homepage.show();
    homepage.focus();
    return homepage;
  }
  homepage = new BrowserWindow({
    width: FIXED_WIDTH,
    height: FIXED_HEIGHT,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "CiCy Desktop",
    icon: require("../utils/app-icon").appIconPath(), // npx/unpackaged → set the
    // window+taskbar icon ourselves (no .exe to embed it on Windows).
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
  const __verbose = !!(process.env.CICY_DEBUG || process.env.CICY_VERBOSE);
  homepage.webContents.on("console-message", (_e, level, msg, line, source) => {
    // Warnings/errors (level>=2) always surface — they're what diagnose a blank
    // page. The chatty info stream only with CICY_DEBUG.
    if (level >= 2 || (__verbose && level >= 1)) console.log(`[homepage:console L${line}] ${msg}  (${source})`);
  });
  // Log load failures (corrupt/missing install) — no remote fallback by
  // design: the homepage is the bundled SPA, full stop.
  homepage.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[homepage] did-fail-load ${code} ${desc} ${url}`);
  });
  homepage.on("closed", () => { homepage = null; });
  return homepage;
}

function isOpen() {
  return !!((homeTabWc && !homeTabWc.isDestroyed()) || (homepage && !homepage.isDestroyed()));
}

// A stable shim that always resolves to the live homepage surface — the resident
// tab's webContents when present, else the standalone window's. Returned object
// identity is stable so callers that hold it across the async gap before the tab
// exists (appUpdater.init) still work once the tab loads. Used for main→renderer
// pushes: auth:complete (main.js), app:update-state (app-updater.js).
const homeWinShim = {
  get webContents() {
    if (homeTabWc && !homeTabWc.isDestroyed()) return homeTabWc;
    if (homepage && !homepage.isDestroyed()) return homepage.webContents;
    return null;
  },
  isDestroyed() {
    const wc = this.webContents;
    return !wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed());
  },
};

function getHomepageWindow() { return homeWinShim; }

module.exports = { openHomepage, isOpen, getHomepageWindow };
