// CiCy Desktop app-level auto-updater (electron-updater).
//
// Windows: silently downloads in background; installs on next quit.
// macOS:   unsigned builds can't replace themselves — we notify and open the
//          release page instead (user downloads .dmg manually).

const { autoUpdater } = require("electron-updater");
const { app } = require("electron");
const log = require("electron-log");

autoUpdater.logger = log;
autoUpdater.autoDownload = true;        // download silently
autoUpdater.autoInstallOnAppQuit = true; // install on quit (Windows)

let _win = null;
let _state = { status: "idle", progress: null, error: null, info: null };

function broadcast(patch) {
  Object.assign(_state, patch);
  if (_win && !_win.isDestroyed()) {
    _win.webContents.send("app:update-state", _state);
  }
}

function init(mainWin) {
  _win = mainWin;

  autoUpdater.on("checking-for-update",    () => broadcast({ status: "checking" }));
  autoUpdater.on("update-not-available",   (i) => broadcast({ status: "up-to-date", info: i }));
  autoUpdater.on("update-available",       (i) => broadcast({ status: "available", info: i }));
  autoUpdater.on("download-progress",      (p) => broadcast({ status: "downloading", progress: p }));
  autoUpdater.on("update-downloaded",      (i) => broadcast({ status: "ready", info: i }));
  autoUpdater.on("error", (err) => {
    // On macOS unsigned builds, autoUpdater always errors. Fall through quietly.
    log.warn("[app-updater] error:", err.message);
    broadcast({ status: "error", error: err.message });
  });

  // Check once shortly after launch, then every 4 hours.
  setTimeout(() => check(), 15_000);
  setInterval(() => check(), 4 * 60 * 60 * 1000);
}

async function check() {
  try { await autoUpdater.checkForUpdates(); } catch (e) {
    log.warn("[app-updater] check failed:", e.message);
  }
}

function installNow() {
  autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
}

function getState() { return _state; }

module.exports = { init, check, installNow, getState };
