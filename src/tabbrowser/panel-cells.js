// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// panel-cells.js — BrowserView-backed cells for the split panel tab.
//
// Why not <webview>: windows opened from a <webview> guest NEVER get
// window.opener in Electron (long-standing architectural limit), which kills
// every OAuth popup flow (Google GSI posts the credential back via
// postMessage(window.opener) — no opener, no login). Cells are therefore real
// BrowserViews owned by main, layered ABOVE the panel tab's own BrowserView;
// the panel page (split-panel.html) stays the chrome: it computes each cell's
// body rect and syncs [{id,url,rect}] here over IPC. Bonus: each cell has a
// webContentsId, so the electron_tab_* tools (eval/screenshot/navigate) work
// on panel cells exactly like tabs.
const { BrowserView, ipcMain, webContents } = require("electron");

const CHROME_H = 80; // must match tab-browser-tools CHROME_H (panel is a normal tab)

// tab webContents.id -> PanelCells
const registry = new Map();

// strip CiCyDesktop/Electron UA tokens — Google OAuth rejects Electron UAs
// ("this browser may not be secure").
function scrubUA(wc) {
  try { wc.setUserAgent(wc.getUserAgent().replace(/\s(CiCyDesktop|Electron)\/\S+/g, "")); } catch (e) {}
}

class PanelCells {
  constructor(manager, tab) {
    this.m = manager;          // owning TabManager
    this.tabId = tab.id;       // panel tab's webContents.id
    this.views = new Map();    // cellId(string) -> { view, url }
    this.visible = manager.activeId === tab.id;
    try {
      tab.view.webContents.once("destroyed", () => this.destroyAll());
    } catch (e) {}
  }

  tabWc() { try { return webContents.fromId(this.tabId); } catch (e) { return null; } }
  sendState(payload) { const wc = this.tabWc(); if (wc && !wc.isDestroyed()) { try { wc.send("panelcells:state", payload); } catch (e) {} } }

  create(cellId) {
    const view = new BrowserView({
      webPreferences: {
        // same session as profile-0 tabs → team/site logins shared with the rest
        // of the tab window. Plain sandboxed web content: no preload, no Node.
        partition: "persist:sandbox-0",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const wc = view.webContents;
    try { view.setBackgroundColor("#0d0d0f"); } catch (e) {}
    try { wc.cicyAccountIdx = 0; } catch (e) {}
    scrubUA(wc);
    try { require("../utils/context-menu-options").attachContextMenu(wc); } catch (e) {}
    try { require("../utils/window-monitor").attachTabConsole(wc); } catch (e) {}

    // Popups stay IN-APP as real child windows: `action:allow` keeps
    // window.opener (OAuth needs it to postMessage the credential back).
    // Named reuse: GSI opens the same frameName twice expecting to land in the
    // SAME window (Chrome behavior); Electron creates a second one — so reuse
    // by frameName manually, else Google login shows two windows.
    const named = new Map(); // frameName -> BrowserWindow
    try {
      wc.setWindowOpenHandler(({ url, frameName }) => {
        const ex = frameName && named.get(frameName);
        if (ex && !ex.isDestroyed()) {
          try { ex.loadURL(url); ex.focus(); } catch (e) {}
          return { action: "deny" };
        }
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        };
      });
      wc.on("did-create-window", (win, details) => {
        scrubUA(win.webContents);
        const fn = details && details.frameName;
        if (fn) { named.set(fn, win); win.on("closed", () => { if (named.get(fn) === win) named.delete(fn); }); }
      });
    } catch (e) {}

    // push nav state back to the panel chrome (url input / spinner / persistence)
    const push = () => {
      let url = "", title = "";
      try { url = wc.getURL(); title = wc.getTitle(); } catch (e) {}
      this.sendState({ id: cellId, url, title, loading: false, wcId: wc.id });
    };
    wc.on("did-start-loading", () => this.sendState({ id: cellId, loading: true, wcId: wc.id }));
    wc.on("did-stop-loading", push);
    wc.on("did-navigate", push);
    wc.on("did-navigate-in-page", push);
    wc.on("page-title-updated", push);

    const rec = { view, url: "" };
    this.views.set(String(cellId), rec);
    return rec;
  }

  place(rec, rect) {
    if (!rect) return;
    const b = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)) + CHROME_H,
      width: Math.max(0, Math.round(rect.w)),
      height: Math.max(0, Math.round(rect.h)),
    };
    try { rec.view.setBounds(b); } catch (e) {}
  }

  // cells: [{id, url, rect:{x,y,w,h}}] in panel-page CSS coords
  sync(cells) {
    if (!Array.isArray(cells)) return;
    const seen = new Set();
    for (const c of cells.slice(0, 24)) {
      if (c == null || c.id == null) continue;
      const key = String(c.id);
      seen.add(key);
      let rec = this.views.get(key);
      if (!rec) rec = this.create(c.id);
      const url = (c.url && String(c.url)) || "";
      if (url && rec.url !== url) {
        rec.url = url;
        try { rec.view.webContents.loadURL(url); } catch (e) {}
      }
      this.place(rec, c.rect);
    }
    for (const key of [...this.views.keys()]) if (!seen.has(key)) this.destroyCell(key);
    this.updateAttach();
  }

  reload(cellId) {
    const rec = this.views.get(String(cellId));
    if (rec) { try { rec.view.webContents.reload(); } catch (e) {} }
  }

  updateAttach() {
    const win = this.m.win;
    if (!win || win.isDestroyed()) return;
    for (const rec of this.views.values()) {
      try {
        if (this.visible) win.addBrowserView(rec.view);   // no-op if already attached
        else win.removeBrowserView(rec.view);
      } catch (e) {}
    }
  }
  show() { this.visible = true; this.updateAttach(); }
  hide() { this.visible = false; this.updateAttach(); }

  destroyCell(key) {
    const rec = this.views.get(key);
    if (!rec) return;
    try { this.m.win.removeBrowserView(rec.view); } catch (e) {}
    try { rec.view.webContents.close(); } catch (e) { try { rec.view.webContents.destroy(); } catch (_) {} }
    this.views.delete(key);
  }
  destroyAll() {
    for (const key of [...this.views.keys()]) this.destroyCell(key);
    registry.delete(this.tabId);
  }
}

function cellsForTab(manager, tab) {
  let pc = registry.get(tab.id);
  if (!pc) { pc = new PanelCells(manager, tab); registry.set(tab.id, pc); }
  return pc;
}

// TabManager.activate hooks — hide the outgoing tab's cells, show the incoming's.
function onTabShown(manager, tabId) { const pc = registry.get(tabId); if (pc) pc.show(); }
function onTabHidden(manager, tabId) { const pc = registry.get(tabId); if (pc) pc.hide(); }

// ── IPC (installed once) ─────────────────────────────────────────────────────
let installed = false;
function installIpc(findTab) {
  if (installed) return;
  installed = true;
  // e.sender is the PANEL PAGE's webContents; findTab maps it to (manager, tab).
  const ctx = (e) => {
    const hit = findTab(e.sender.id);
    return hit ? cellsForTab(hit.manager, hit.tab) : null;
  };
  ipcMain.on("panelcells:sync", (e, { cells }) => { const pc = ctx(e); if (pc) pc.sync(cells); });
  ipcMain.on("panelcells:reload", (e, { id }) => { const pc = ctx(e); if (pc) pc.reload(id); });
  // divider drag in the panel page: views would swallow pointer events — detach
  // during the drag (page shows frame-only preview), reattach + re-place on up.
  ipcMain.on("panelcells:drag", (e, { on }) => { const pc = ctx(e); if (pc) { if (on) pc.hide(); else pc.show(); } });
}

module.exports = { installIpc, onTabShown, onTabHidden };
