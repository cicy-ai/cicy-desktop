// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Preload for the split panel page (cicyui://panel/<id>). Exposes window.panelAPI
// so the page (pure chrome: headers/dividers/layout) drives main-process
// BrowserView cells (panel-cells.js). Sandbox-safe: only contextBridge + ipcRenderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("panelAPI", {
  // full desired state, main reconciles: [{id, url, rect:{x,y,w,h}}]
  sync: (cells) => ipcRenderer.send("panelcells:sync", { cells }),
  reload: (id) => ipcRenderer.send("panelcells:reload", { id }),
  states: () => ipcRenderer.invoke("panelcells:states"),
  agents: () => ipcRenderer.invoke("panelcells:agents"),
  profiles: () => ipcRenderer.invoke("panelcells:profiles"),
  addProfile: () => ipcRenderer.invoke("panelcells:add-profile"),
  setProfileProxy: (accountIdx, proxy) => ipcRenderer.invoke("panelcells:set-profile-proxy", { accountIdx, proxy }),
  setProfileNote: (accountIdx, note) => ipcRenderer.invoke("panelcells:set-profile-note", { accountIdx, note }),
  setProfileLogin: (accountIdx, phone, codeUrl) => ipcRenderer.invoke("panelcells:set-profile-login", { accountIdx, phone, codeUrl }),
  openCodeUrl: (accountIdx, url) => ipcRenderer.invoke("panelcells:open-code-url", { accountIdx, url }),
  probeIp: (accountIdx) => ipcRenderer.invoke("panelcells:probe-ip", { accountIdx }),
  removeProfile: (accountIdx) => ipcRenderer.invoke("panelcells:remove-profile", { accountIdx }),
  snapshots: () => ipcRenderer.invoke("panelcells:snapshots"),
  // divider drag: BrowserViews sit ABOVE the page and would swallow pointermove —
  // detach them for the duration of the drag (frame-only preview), reattach on up.
  dragging: (on) => ipcRenderer.send("panelcells:drag", { on: !!on }),
  onCellState: (cb) => {
    const h = (_e, s) => { try { cb(s); } catch (e) {} };
    ipcRenderer.on("panelcells:state", h);
    return () => ipcRenderer.removeListener("panelcells:state", h);
  },
});

// Redroid 矩阵 page: docker+adb driven Android devices (redroid-matrix.js).
const rd = (ch) => (args) => ipcRenderer.invoke(`redroid:${ch}`, args || {});
contextBridge.exposeInMainWorld("redroidAPI", {
  defaults: rd("defaults"),
  list: rd("list"),
  create: rd("create"),
  start: (name) => rd("start")({ name }),
  stop: (name) => rd("stop")({ name }),
  restart: (name) => rd("restart")({ name }),
  remove: (name, purge) => rd("remove")({ name, purge }),
  screenshot: (name) => rd("screenshot")({ name }),
  input: (name, event) => rd("input")({ name, event }),
  setProxy: (name, proxy) => rd("set-proxy")({ name, proxy }),
  probeIp: (name) => rd("probe-ip")({ name }),
  frida: (name, on) => rd("frida")({ name, on }),
  apps: (name) => rd("apps")({ name }),
  launch: (name, pkg) => rd("launch")({ name, pkg }),
  uninstall: (name, pkg) => rd("uninstall")({ name, pkg }),
  install: (name) => rd("install")({ name }),
  shell: (name, cmd) => rd("shell")({ name, cmd }),
  onProgress: (cb) => {
    const h = (_e, m) => { try { cb(m); } catch (e) {} };
    ipcRenderer.on("redroid:progress", h);
    return () => ipcRenderer.removeListener("redroid:progress", h);
  },
});
