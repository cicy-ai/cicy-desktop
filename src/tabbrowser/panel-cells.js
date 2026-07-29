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
const fs = require("fs");
const os = require("os");
const path = require("path");

// Panel tabs only exist in profile 0, whose URL toolbar is hidden. Their page
// starts immediately below the 40px tab strip, so native cell BrowserViews do too.
const CHROME_H = 40;

// Each cell picks its PROFILE (accountIdx → persist:sandbox-N), default 1.
// Profile 0 is hard-forced DIRECT (no proxy — the gotty terminal ws must never
// route into mihomo), so external sites (x.com / accounts.google.com) belong in
// profile ≥1: per-profile proxy from account-N.json (fallback config.proxy)
// with localhost ALWAYS bypassed — team pages (127.0.0.1:8008) stay direct in
// every profile. Team auth is token-in-URL, so cookie isolation costs nothing.
const DEFAULT_PROFILE = 1;
const partitionFor = (idx) => `persist:sandbox-${idx}`;
// URL → profile routing (用户定的规则): localhost/127.0.0.1 → profile 0(直连、
// 与团队 tab 同会话);其余一律 profile 1(走代理)。按格子的目标 URL 定,变更时重建视图。
function isLocalCicyCode(url) {
  try {
    const u = new URL(url);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
    return local && (u.port || "80") === "8008";
  } catch (e) {}
  return false;
}
function profileForCell(url, requested) {
  if (isLocalCicyCode(url)) return 0;
  const idx = Number(requested);
  return Number.isInteger(idx) && idx > 0 ? idx : DEFAULT_PROFILE;
}
const appliedProxy = new Set(); // partitions whose proxy is already configured
function ensureCellSessionProxy(idx) {
  const part = partitionFor(idx);
  if (appliedProxy.has(part)) return;
  appliedProxy.add(part);
  if (idx === 0) return; // profile 0 stays direct — managed by window-utils, don't touch
  try {
    const profileStore = require("../profiles/profile-store");
    let rules = "";
    try { const p = profileStore.getProfile("electron", idx); rules = profileStore.proxyRules(p && p.proxy) || ""; } catch (e) {}
    if (!rules) { try { rules = require("../config").config.proxy || ""; } catch (e) {} }
    if (!rules) return;
    session.fromPartition(part)
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

  create(cellId, profileIdx) {
    ensureCellSessionProxy(profileIdx);
    const view = new BrowserView({
      webPreferences: {
        // the cell's chosen profile session: proxied external web (profile ≥1),
        // localhost bypassed. Plain sandboxed web content: no preload, no Node.
        partition: partitionFor(profileIdx),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const wc = view.webContents;
    try { view.setBackgroundColor("#ffffff"); } catch (e) {}
    try { wc.cicyAccountIdx = profileIdx; } catch (e) {}
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
      // did-navigate / page-title-updated commonly fire while the document is
      // still loading. Hard-coding false here hid the spinner immediately after
      // did-start-loading; report the BrowserView's actual state instead.
      let loading = false;
      try { loading = wc.isLoading(); } catch (e) {}
      this.sendState({ id: cellId, url, title, loading, wcId: wc.id });
    };
    wc.on("did-start-loading", () => this.sendState({ id: cellId, loading: true, wcId: wc.id }));
    wc.on("did-stop-loading", push);
    wc.on("did-fail-load", push);
    wc.on("did-navigate", push);
    wc.on("did-navigate-in-page", push);
    wc.on("page-title-updated", push);

    const rec = { view, url: "", profile: profileIdx };
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
      const url = (c.url && String(c.url)) || "";
      const prof = profileForCell(url, c.profile);
      let rec = this.views.get(key);
      // locality change (localhost ↔ external) → partition must change → rebuild
      if (rec && rec.profile !== prof) { this.destroyCell(key); rec = null; }
      if (!rec) rec = this.create(c.id, prof);
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

  async snapshots() {
    const out = [];
    for (const [id, rec] of this.views) {
      try {
        const image = await rec.view.webContents.capturePage();
        if (!image.isEmpty()) out.push({ id, dataUrl: image.toDataURL() });
      } catch (e) {}
    }
    return out;
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
  ipcMain.handle("panelcells:profiles", (e) => {
    if (!ctx(e)) return [];
    try {
      return require("../profiles/profile-store").listProfiles("electron")
        .filter((p) => Number.isInteger(Number(p.accountIdx)) && Number(p.accountIdx) > 0 && Number(p.accountIdx) !== 9)
        .map((p) => ({ accountIdx: Number(p.accountIdx), name: String(p.name || "") }));
    } catch (err) { return []; }
  });
  ipcMain.handle("panelcells:snapshots", async (e) => {
    const pc = ctx(e);
    return pc ? pc.snapshots() : [];
  });
  ipcMain.handle("panelcells:agents", async (e) => {
    if (!ctx(e)) return { ok: false, agents: [], error: "invalid panel" };
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), "cicy-ai", "global.json"), "utf8"));
      const token = String(cfg.api_token || "");
      const r = await fetch("http://127.0.0.1:8008/api/tmux/panes", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const panes = data?.panes || data?.data?.panes || [];
      return {
        ok: true,
        agents: panes.map((p) => ({
          id: String(p.pane_id || "").replace(/:.*$/, ""),
          title: String(p.title || p.pane_id || ""),
          type: String(p.agent_type || ""),
        })).filter((p) => p.id),
      };
    } catch (err) {
      return { ok: false, agents: [], error: err.message || String(err) };
    }
  });
  // divider drag in the panel page: views would swallow pointer events — detach
  // during the drag (page shows frame-only preview), reattach + re-place on up.
  ipcMain.on("panelcells:drag", (e, { on }) => { const pc = ctx(e); if (pc) { if (on) pc.hide(); else pc.show(); } });
}

module.exports = { installIpc, onTabShown, onTabHidden };
