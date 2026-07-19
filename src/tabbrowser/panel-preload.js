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
  // divider drag: BrowserViews sit ABOVE the page and would swallow pointermove —
  // detach them for the duration of the drag (frame-only preview), reattach on up.
  dragging: (on) => ipcRenderer.send("panelcells:drag", { on: !!on }),
  onCellState: (cb) => {
    const h = (_e, s) => { try { cb(s); } catch (e) {} };
    ipcRenderer.on("panelcells:state", h);
    return () => ipcRenderer.removeListener("panelcells:state", h);
  },
});
