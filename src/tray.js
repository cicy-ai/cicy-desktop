// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Tray icon (macOS menu bar / Windows + Linux system tray) and macOS dock icon.
// Loaded once after app.whenReady(). Resources live in build/ alongside the
// platform installer icons; we ship them via electron-builder's `extraResources`
// so they're available at runtime in both dev (./build/...) and packaged
// (process.resourcesPath/build/...) modes.

const { app, Tray, Menu, nativeImage, dialog } = require("electron");
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

async function openCicyAiInProfile1() {
  try {
    const tabs = require("./tools/tab-browser-tools");
    await tabs.openTab(1, "https://cicy-ai.com", { activate: true });
    const manager = tabs.ensureManager(1);
    if (manager.win.isMinimized()) manager.win.restore();
    manager.win.show();
    manager.win.focus();
  } catch (e) {
    log.warn(`[Tray] open cicy-ai.com in Electron Profile 1 failed: ${e.message}`);
  }
}

async function openElectronProfile(accountIdx) {
  try {
    const tabs = require("./tools/tab-browser-tools");
    await tabs.openTab(accountIdx, undefined, { activate: true });
    const manager = tabs.ensureManager(accountIdx);
    if (manager.win.isMinimized()) manager.win.restore();
    manager.win.show();
    manager.win.focus();
  } catch (e) {
    showProfileError("Electron", e);
  }
}

async function openChromeProfile(accountIdx) {
  try {
    await require("./tools/chrome-tools").launchOrActivateProfile({
      accountIdx,
      activateIfRunning: true,
    });
  } catch (e) {
    showProfileError("Chrome", e);
  }
}

function showProfileError(kind, error) {
  dialog.showMessageBox({
    type: "error",
    message: `${kind} Profile 操作失败`,
    detail: String((error && error.message) || error),
    buttons: ["OK"],
  });
}

function listProfiles(backend) {
  try {
    let rows = require("./profiles/profile-store").listProfiles(backend);
    if (backend === "electron") {
      rows = rows.filter((p) => ![0, 9].includes(Number(p.accountIdx)));
    }
    return rows;
  } catch (_) {
    return [];
  }
}

async function addProfileFromTray(kind) {
  try {
    const { executeTool } = require("./server/tool-executor");
    const result = await executeTool(kind === "Electron" ? "electron_add_profile" : "chrome_add_profile", {});
    const text = result && result.content && result.content[0] && result.content[0].text;
    let data = {};
    try { data = JSON.parse(text || "{}"); } catch {}
    if (result && result.isError) throw new Error(data.error || text || "unknown error");
    const accountIdx = Number(data.accountIdx ?? (data.created && data.created.accountIdx));
    installTrayMenu();
    if (Number.isFinite(accountIdx)) {
      if (kind === "Electron") await openElectronProfile(accountIdx);
      else await openChromeProfile(accountIdx);
    }
  } catch (e) {
    showProfileError(kind, e);
  }
}

function installTrayMenu() {
  if (!trayInstance) return;
  const electronRows = listProfiles("electron");
  const chromeRows = listProfiles("chrome");
  const template = [
    {
      label: i18n.t("tray.openHomepage"),
      click: () => openHomepage(),
    },
    ...(process.platform === "win32" ? [
      {
        label: "打开 cicy-ai.com",
        click: () => openCicyAiInProfile1(),
      },
      { type: "separator" },
      {
        label: "Electron",
        submenu: [
          { label: "新增 Profile", click: () => addProfileFromTray("Electron") },
          ...(electronRows.length ? [{ type: "separator" }] : []),
          ...electronRows.map((p) => ({
            label: `Profile ${p.accountIdx}${p.name ? ` · ${p.name}` : ""}`,
            click: () => openElectronProfile(Number(p.accountIdx)),
          })),
        ],
      },
      {
        label: "Chrome",
        submenu: [
          { label: "新增 Profile", click: () => addProfileFromTray("Chrome") },
          { label: "原生 Chrome", click: () => {
            try { require("./tools/chrome-tools").launchNativeChrome(); }
            catch (e) { showProfileError("Chrome", e); }
          } },
          ...(chromeRows.length ? [{ type: "separator" }] : []),
          ...chromeRows.map((p) => ({
            label: `Profile ${p.accountIdx}${p.gmail ? ` · ${p.gmail}` : p.note ? ` · ${p.note}` : ""}`,
            click: () => openChromeProfile(Number(p.accountIdx)),
          })),
        ],
      },
    ] : []),
    { type: "separator" },
    {
      label: i18n.t("tray.quit"),
      click: () => app.quit(),
    },
  ];
  trayInstance.setContextMenu(Menu.buildFromTemplate(template));
}

function setupTray() {
  try {
    let iconPath;
    if (process.platform === "darwin") {
      // macOS: template image (auto-adapts to light/dark menu bar)
      iconPath = resolveAsset("trayTemplate.png");
    } else if (process.platform === "win32") {
      // Keep the white app/window tile out of the notification area: Windows
      // tray uses the colored transparent logo instead.
      iconPath = resolveAsset("trayIcon.png");
    } else {
      iconPath = resolveAsset("trayIcon.png");
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
    installTrayMenu();

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
