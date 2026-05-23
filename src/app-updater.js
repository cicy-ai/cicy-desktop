// CiCy Desktop app-level auto-updater (electron-updater).
//
// Windows: silently downloads in background; installs on next quit.
// macOS:   unsigned builds can't replace themselves — we notify and open the
//          release page instead (user downloads .dmg manually).

const { autoUpdater } = require("electron-updater");
const { app } = require("electron");
const path = require("path");
const log = require("electron-log");

// ghproxy mirrors — same list as installer.js
const CN_MIRRORS = ["https://gh.llkk.cc/", "https://ghproxy.net/", "https://gh-proxy.com/"];
const GH_BASE = "https://github.com/cicy-ai/cicy-desktop/releases/latest/download";

// Probe network once and cache.
let _network = null;
async function detectNetwork() {
  if (_network) return _network;
  try {
    const detect = require("../sidecar/net-detect");
    _network = await detect();
  } catch {
    _network = "unknown";
  }
  return _network;
}

// Set feed URL: CN → generic provider via first reachable mirror;
//               global → default GitHub provider (no change).
async function applyFeedUrl() {
  const net = await detectNetwork();
  if (net !== "cn") {
    autoUpdater.setFeedURL({ provider: "github", owner: "cicy-ai", repo: "cicy-desktop" });
    return;
  }
  // Try mirrors in order; use the first one that can fetch latest.yml.
  const https = require("https");
  for (const mirror of CN_MIRRORS) {
    const url = `${mirror}${GH_BASE}`;
    const ok = await new Promise(resolve => {
      const req = https.request(url + "/latest.yml", { method: "HEAD", timeout: 4000 }, r => resolve(r.statusCode < 400));
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok) {
      log.info(`[app-updater] CN network — using mirror: ${mirror}`);
      autoUpdater.setFeedURL({ provider: "generic", url });
      return;
    }
  }
  // All mirrors failed, fall back to direct
  log.warn("[app-updater] CN mirrors unreachable, falling back to direct GitHub");
  autoUpdater.setFeedURL({ provider: "github", owner: "cicy-ai", repo: "cicy-desktop" });
}

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
  if (!app.isPackaged) {
    // Dev mode: point at the real GitHub repo so we can test the full
    // check → download → ready flow without a packaged build.
    // Install won't work (no ASAR to replace), but state transitions will.
    const devCfg = path.join(__dirname, "..", "dev-app-update.yml");
    if (!require("fs").existsSync(devCfg)) {
      log.info("[app-updater] dev mode — no dev-app-update.yml, skipping");
      return;
    }
    autoUpdater.updateConfigPath = devCfg;
    autoUpdater.forceDevUpdateConfig = true;
    log.info("[app-updater] dev mode — using dev-app-update.yml");
  }
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
  try {
    await applyFeedUrl();
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log.warn("[app-updater] check failed:", e.message);
  }
}

function installNow() {
  autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
}

function getState() { return _state; }

module.exports = { init, check, installNow, getState };
