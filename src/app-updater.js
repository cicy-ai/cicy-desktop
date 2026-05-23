// CiCy Desktop app-level auto-updater (electron-updater).
//
// Windows: silently downloads in background; installs on next quit.
// macOS:   unsigned builds can't replace themselves — we notify and open the
//          release page instead (user downloads .dmg manually).

const { autoUpdater } = require("electron-updater");
const { app } = require("electron");
const path = require("path");
const log = require("electron-log");
const { resolveFeedUrl } = require("./sidecar/mirrors");

const GH_FEED_BASE = "https://github.com/cicy-ai/cicy-desktop/releases/latest/download";

// Probe network once and cache.
let _network = null;
async function detectNetwork() {
  if (_network) return _network;
  try { _network = await require("./sidecar/net-detect")(); }
  catch { _network = "unknown"; }
  return _network;
}

// Set feed URL: CN → first reachable mirror via mirrors.js;
//               global → default GitHub provider.
async function applyFeedUrl() {
  const net = await detectNetwork();
  const feedUrl = net === "cn" ? await resolveFeedUrl(GH_FEED_BASE) : GH_FEED_BASE;
  if (feedUrl === GH_FEED_BASE) {
    autoUpdater.setFeedURL({ provider: "github", owner: "cicy-ai", repo: "cicy-desktop" });
  } else {
    log.info(`[app-updater] CN — feed: ${feedUrl}`);
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
  }
}

autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false; // we call quitAndInstall() ourselves

let _win = null;
let _state = { status: "idle", progress: null, error: null, info: null };

function broadcast(patch) {
  Object.assign(_state, patch);
  if (_win && !_win.isDestroyed()) _win.webContents.send("app:update-state", _state);
}

function init(mainWin) {
  _win = mainWin;
  if (!app.isPackaged) {
    const devCfg = path.join(__dirname, "..", "dev-app-update.yml");
    if (!require("fs").existsSync(devCfg)) {
      log.info("[app-updater] dev mode — no dev-app-update.yml, skipping");
      return;
    }
    autoUpdater.updateConfigPath = devCfg;
    autoUpdater.forceDevUpdateConfig = true;
    log.info("[app-updater] dev mode — using dev-app-update.yml");
  }

  autoUpdater.on("checking-for-update",  () => broadcast({ status: "checking" }));
  autoUpdater.on("update-not-available", (i) => broadcast({ status: "up-to-date", info: i }));
  autoUpdater.on("update-available",     (i) => broadcast({ status: "available", info: i }));
  autoUpdater.on("download-progress",    (p) => broadcast({ status: "downloading", progress: p }));
  autoUpdater.on("update-downloaded",    (i) => {
    broadcast({ status: "ready", info: i });
    // Auto-install: kill current process and launch the new version immediately.
    // On Windows this is the NSIS installer running silently + re-launching.
    // On macOS (unsigned) this will throw — caught and logged, no crash.
    log.info("[app-updater] update downloaded, applying now");
    setTimeout(() => {
      try { autoUpdater.quitAndInstall(true, true); } catch (e) {
        log.warn("[app-updater] quitAndInstall failed:", e.message);
      }
    }, 1500); // brief delay so the UI can show "ready" state
  });
  autoUpdater.on("error", (err) => {
    log.warn("[app-updater] error:", err.message);
    broadcast({ status: "error", error: err.message });
  });

  setTimeout(() => check(), 15_000);
  setInterval(() => check(), 4 * 60 * 60 * 1000);
}

async function check() {
  try {
    await applyFeedUrl();
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log.warn("[app-updater] check failed:", e.message);
  }
}

function installNow() {
  autoUpdater.quitAndInstall(false, true);
}

function getState() { return _state; }

module.exports = { init, check, installNow, getState };
