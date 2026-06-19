// Preload for the BrowserView tab-browser shell (tab strip + toolbar).
// Exposes window.tabAPI so the chrome UI drives the main-process TabManager,
// and receives tab state pushes. Tabs themselves are BrowserViews (managed in
// main) — this preload is ONLY for the thin chrome UI, never the tab content.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tabAPI", {
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
