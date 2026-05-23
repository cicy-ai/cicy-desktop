// Tray icon (macOS menu bar / Windows + Linux system tray) and macOS dock icon.
// Loaded once after app.whenReady(). Resources live in build/ alongside the
// platform installer icons; we ship them via electron-builder's `extraResources`
// so they're available at runtime in both dev (./build/...) and packaged
// (process.resourcesPath/build/...) modes.

const { app, Tray, Menu, nativeImage, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const log = require("electron-log");
const { openHomepage } = require("./backends/homepage-window");
const i18n = require("./i18n");

let trayInstance = null;

function resolveAsset(rel) {
  // dev: source repo; packaged: process.resourcesPath/build/...
  const candidates = [
    path.join(__dirname, "..", "build", rel),
    path.join(process.resourcesPath || "", "build", rel),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function setupDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  try {
    const iconPath = resolveAsset("icon.png");
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      app.dock.setIcon(img);
      log.info(`[Dock] icon set from ${iconPath}`);
    }
  } catch (e) {
    log.warn(`[Dock] setIcon failed: ${e.message}`);
  }
}

function setupTray() {
  try {
    let iconPath;
    if (process.platform === "darwin") {
      // macOS: template image (auto-adapts to light/dark menu bar)
      iconPath = resolveAsset("trayTemplate.png");
    } else if (process.platform === "win32") {
      iconPath = resolveAsset("icon.ico");
    } else {
      iconPath = resolveAsset("icons/icon-32.png");
    }

    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) {
      log.warn(`[Tray] icon empty, skipping: ${iconPath}`);
      return;
    }
    if (process.platform === "darwin") {
      img.setTemplateImage(true);
    }

    trayInstance = new Tray(img);
    trayInstance.setToolTip(i18n.t("tray.tooltip"));

    const menu = Menu.buildFromTemplate([
      {
        label: i18n.t("tray.openHomepage"),
        click: () => openHomepage(),
      },
      { type: "separator" },
      {
        label: i18n.t("tray.quit"),
        click: () => app.quit(),
      },
    ]);
    trayInstance.setContextMenu(menu);

    // Click on tray icon: open homepage on macOS, toggle on others
    trayInstance.on("click", () => openHomepage());

    log.info(`[Tray] icon loaded from ${iconPath}`);
  } catch (e) {
    log.warn(`[Tray] setup failed: ${e.message}`);
  }
}

function setupAppIcons() {
  setupDockIcon();
  setupTray();
}

module.exports = { setupAppIcons };
