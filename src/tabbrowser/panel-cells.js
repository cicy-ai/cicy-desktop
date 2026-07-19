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
const { BrowserView, ipcMain, webContents, session } = require("electron");

const CHROME_H = 80; // must match tab-browser-tools CHROME_H (panel is a normal tab)

// Cells run in PROFILE 1's session, NOT profile 0: account 0 is hard-forced
// DIRECT (no proxy — the gotty terminal ws must never route into mihomo), so
// x.com / accounts.google.com would be unreachable from CN inside a cell.
// Profile 1 is the standard browsing profile: per-profile proxy from
// account-1.json (fallback config.proxy) with localhost ALWAYS bypassed, so
// team pages (127.0.0.1:8008) in cells stay direct. Team auth is token-in-URL,
// so not sharing profile-0 cookies costs nothing.
const CELL_PARTITION = "persist:sandbox-1";
let cellProxyApplied = false;
function ensureCellSessionProxy() {
  if (cellProxyApplied) return;
  cellProxyApplied = true;
  try {
    const profileStore = require("../profiles/profile-store");
    let rules = "";
    try { rules = profileStore.proxyRules(profileStore.getProfile("electron", 1) && profileStore.getProfile("electron", 1).proxy) || ""; } catch (e) {}
    if (!rules) { try { rules = require("../config").config.proxy || ""; } catch (e) {} }
    if (!rules) return;
    session.fromPartition(CELL_PARTITION)
      .setProxy({ proxyRules: rules, proxyBypassRules: "127.0.0.1,localhost,[::1]" })
      .catch(() => {});
  } catch (e) {}
}

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
    ensureCellSessionProxy();
    const view = new BrowserView({
      webPreferences: {
        // profile 1's session (see CELL_PARTITION above): proxied external web,
        // localhost bypassed. Plain sandboxed web content: no preload, no Node.
        partition: CELL_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const wc = view.webContents;
    try { view.setBackgroundColor("#0d0d0f"); } catch (e) {}
    try { wc.cicyAccountIdx = 1; } catch (e) {}
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
