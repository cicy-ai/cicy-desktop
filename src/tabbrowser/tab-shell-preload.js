// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Preload for the BrowserView tab-browser shell (tab strip + toolbar).
// Exposes window.tabAPI so the chrome UI drives the main-process TabManager,
// and receives tab state pushes. Tabs themselves are BrowserViews (managed in
// main) — this preload is ONLY for the thin chrome UI, never the tab content.
const { contextBridge, ipcRenderer } = require("electron");

// i18n: this preload runs in the renderer process, so require("../i18n") is a
// SEPARATE instance from main — init it with the main process's chosen locale
// (i18n:locale ipc), so window.tabAPI.t matches the rest of the app.
let __i18n = null;
try {
  __i18n = require("../i18n");
  let mainLng;
  try { mainLng = ipcRenderer.sendSync("i18n:locale"); } catch (_) {}
  __i18n.init(mainLng || undefined);
  if (mainLng && __i18n.i18next.language !== __i18n.pickLocale(mainLng)) {
    __i18n.i18next.changeLanguage(__i18n.pickLocale(mainLng));
  }
} catch (e) { __i18n = null; }

contextBridge.exposeInMainWorld("tabAPI", {
  t: (key, fallback) => { try { return __i18n ? __i18n.t(key, { defaultValue: fallback }) : fallback; } catch (e) { return fallback; } },
  newTab: (url) => ipcRenderer.send("tabwin:new", { url: url || "" }),
  activate: (id) => ipcRenderer.send("tabwin:activate", { id }),
  close: (id) => ipcRenderer.send("tabwin:close", { id }),
  // Reorder tabs (Chrome-style drag). `ids` = the new order of NON-home tab ids;
  // main keeps the resident homepage tab pinned first.
  reorder: (ids) => ipcRenderer.send("tabwin:reorder", { ids }),
  navigate: (url) => ipcRenderer.send("tabwin:navigate", { url }),
  back: () => ipcRenderer.send("tabwin:back"),
  fwd: () => ipcRenderer.send("tabwin:fwd"),
  reload: () => ipcRenderer.send("tabwin:reload"),
  ready: () => ipcRenderer.send("tabwin:ready"),
  onState: (cb) => {
    const h = (_e, s) => { try { cb(s); } catch (e) {} };
    ipcRenderer.on("tabwin:state", h);
    return () => ipcRenderer.removeListener("tabwin:state", h);
  },
  // mac native fullscreen toggles the traffic lights → the strip reclaims the
  // reserved left gutter. cb(isFullScreen:boolean).
  onFullscreen: (cb) => {
    const h = (_e, fs) => { try { cb(!!fs); } catch (e) {} };
    ipcRenderer.on("window:fullscreen", h);
    return () => ipcRenderer.removeListener("window:fullscreen", h);
  },
});
