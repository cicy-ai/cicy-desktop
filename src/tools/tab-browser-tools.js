// tab-browser-tools.js — Chrome-like tabbed browser, one window per profile,
// built on BrowserView tabs (NOT <webview>), so each tab is a full webContents
// that can itself host <webview> (the cicy-code team app's artifact frame, the
// homepage's team-assistant drawer) — nested webviews work.
//
// Model (additive — the existing win_id BrowserWindow tools are untouched):
//   • one profile (accountIdx → persist:sandbox-N) == one tabbed BrowserWindow
//     whose chrome (tab strip + toolbar) is tab-shell.html; each tab is a
//     BrowserView positioned below the 80px chrome.
//   • every "open" goes in as a TAB, never a new window (homepage / teams /
//     window.open all become tabs).
//   • each tab is addressed by its webContents.id (like a Chrome target).
//   • per-tab preload: home → homepage-preload (window.cicy bridges),
//     trusted (team) → webview-preload (electronRPC), plain site → none.
const path = require("path");
const { z } = require("zod");
const { app, BrowserWindow, BrowserView, webContents, ipcMain } = require("electron");
const { attachContextMenu } = require("../utils/context-menu-options");

const SHELL_HTML = path.join(__dirname, "..", "tabbrowser", "tab-shell.html");
const SHELL_PRELOAD = path.join(__dirname, "..", "tabbrowser", "tab-shell-preload.js");
const HOMEPAGE_PRELOAD = path.join(__dirname, "..", "backends", "homepage-preload.js");
const WEBVIEW_PRELOAD = path.join(__dirname, "..", "backends", "webview-preload.js");
const CHROME_H = 80;  // tab strip (40) + toolbar (40) — must match tab-shell.html
const STRIP_H = 40;   // tab strip only; the homepage tab hides the toolbar (no address bar)

const managers = new Map();      // accountIdx -> TabManager
const managerByHost = new Map(); // shell webContents.id -> TabManager

function stripVol(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return u || ""; } }

const { NEWTAB_URL, ensureForPartition } = require("../tabbrowser/newtab-protocol");

// ── Per-profile privilege gate ────────────────────────────────────────────────
// Security model: accountIdx 0 is the SYSTEM profile (homepage + team apps) and
// is the ONLY profile allowed to run privileged tabs — Node-capable preloads
// (homepage-preload / webview-preload → window.electronRPC), <webview>, and
// insecure content. Profile-0 tabs carry the electronRPC bridge, but it is gated
// at CALL TIME: a non-allowlisted origin must pass the rpc:guarded consent modal
// (ensureOriginAuthorized) before any tool runs. Every other profile (accountIdx
// ≥ 1) is a HARD-SANDBOXED web browser: contextIsolation on, nodeIntegration off,
// OS sandbox on, NO preload, NO webviewTag — so a sandbox profile can never reach
// the electronRPC bridge, Node, or nest another webview, whatever flags a caller
// passes.
function buildTabWebPreferences(accountIdx, partition, target, opts = {}) {
  const wp = { partition, contextIsolation: true, nodeIntegration: false, sandbox: true };
  if (accountIdx !== 0) return wp; // sandbox profiles: locked baseline, no exceptions
  // homepage-preload does Node require()s (../i18n, path) → must run unsandboxed.
  // home is system-driven (openHomeWindow), never caller-URL-reachable, so it
  // keeps its privileges without a URL check.
  if (opts.home) { wp.preload = HOMEPAGE_PRELOAD; wp.webviewTag = true; wp.allowRunningInsecureContent = true; wp.sandbox = false; }
  // Every other profile-0 tab carries the electronRPC bridge (WEBVIEW_PRELOAD),
  // but the bridge is INERT until the page's origin is authorized: the first
  // rpc:guarded call from a non-allowlisted origin pops a consent modal
  // (ensureOriginAuthorized) that can deny, allow once, or add the domain to the
  // trusted-origins allowlist. Trust moved from inject-time to call-time so the
  // user can grant it on demand instead of hitting a silent "electronRPC not
  // available". The page itself still can't reach Node (contextIsolation on,
  // nodeIntegration off) — only the preload runs privileged, and it exposes
  // nothing but the gated bridge.
  else { wp.preload = WEBVIEW_PRELOAD; wp.webviewTag = true; wp.sandbox = false; }
  return wp;
}
function startPageUrl(_accountIdx) {
  // clean cicy://newtab instead of a giant data: URL (served by newtab-protocol).
  return NEWTAB_URL;
}

class TabManager {
  constructor(accountIdx) {
    this.accountIdx = accountIdx;
    this.partition = `persist:sandbox-${accountIdx}`;
    ensureForPartition(this.partition); // register cicyui://newtab on this session
    this.tabs = [];        // [{ id(=webContents.id), view, title, url }]
    this.activeId = null;
    // profile 0 is the primary window (its first tab is the resident homepage),
    // so give it the app title/icon; other profiles are sandbox browsers.
    const STRIP_BG = "#1c1c20"; // matches tab-shell.html --strip so the titlebar merges in
    const winOpts = {
      width: 1180,
      height: 820,
      backgroundColor: STRIP_BG,
      title: accountIdx === 0 ? "CiCy Desktop" : `CiCy Browser · sandbox-${accountIdx}`,
      // Drop the native title-bar row — the tab strip becomes the top of the window
      // (Chrome-style). mac: keep traffic lights, inset into the strip. win: keep the
      // min/max/close as an overlay tinted to the strip color so it merges. (Linux:
      // leave the default frame.)
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 13 } }
        : {}),
      ...(process.platform === "win32"
        ? { titleBarStyle: "hidden", titleBarOverlay: { color: STRIP_BG, symbolColor: "#e8eaed", height: 40 } }
        : {}),
      // win/linux: hide the native application menu bar too (mac keeps it in the
      // global bar). Without this, Windows draws the File/Edit/View row where the
      // titlebar was, so the strip never reaches the top edge. Alt still reveals it.
      autoHideMenuBar: true,
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, nodeIntegration: false },
    };
    try { winOpts.icon = require("../utils/app-icon").appIconPath(); } catch (e) {}
    this.win = new BrowserWindow(winOpts);
    // profile 0 is the system tab window (teams only) — no manual "+" new tab.
    this.win.loadFile(SHELL_HTML, { query: { p: String(accountIdx), noNew: accountIdx === 0 ? "1" : "0", plat: process.platform } });
    managerByHost.set(this.win.webContents.id, this);
    // Fullscreen hides the OS window controls (mac traffic lights / win caption
    // buttons) → tell the shell so it reclaims the reserved gutter (CSS
    // body.is-fullscreen). Fires on both mac and Windows. MUST also reach every
    // TAB's renderer: the homepage SPA (homepage-preload) toggles its own
    // data-fullscreen attr to drop the 34px traffic-light gutter — and the
    // homepage now runs as a resident BrowserView TAB, not this.win.webContents.
    // Without forwarding to the tab, the gutter stays in fullscreen = a blank
    // strip across the top of 我的团队 (reported on mac fullscreen).
    this.win.on("enter-full-screen", () => this.sendFullscreen(true));
    this.win.on("leave-full-screen", () => this.sendFullscreen(false));
    this.win.on("resize", () => this.layout());
    this.win.on("closed", () => {
      managers.delete(accountIdx);
      managerByHost.delete(this.win.webContents.id);
    });
  }

  // Broadcast the window's fullscreen state to the shell chrome AND every tab's
  // renderer. The homepage tab's SPA needs it to collapse the mac traffic-light
  // gutter; other tabs simply ignore the message.
  sendFullscreen(isFs) {
    try { this.win.webContents.send("window:fullscreen", isFs); } catch (e) {}
    for (const t of this.tabs) {
      try { t.view.webContents.send("window:fullscreen", isFs); } catch (e) {}
    }
  }

  pushState() {
    const active = this.tabs.find((t) => t.id === this.activeId);
    let wc = null;
    try { wc = active ? active.view.webContents : null; } catch (e) {}
    const s = {
      tabs: this.tabs.map((t) => ({
        id: t.id,
        // fixedTitle (team title / homepage) wins over the page's own document.title
        title: t.fixedTitle || t.title || "新标签页",
        url: t.url || "",
        active: t.id === this.activeId,
        loading: !!t.loading,
        favicon: t.favicon || "",
        home: !!t.home,
      })),
      nav: {
        canBack: wc ? wc.canGoBack() : false,
        canFwd: wc ? wc.canGoForward() : false,
        loading: active ? !!active.loading : false,
        url: active ? active.url || "" : "",
      },
    };
    try { this.win.webContents.send("tabwin:state", s); } catch (e) {}
  }

  layout() {
    const t = this.tabs.find((x) => x.id === this.activeId);
    if (!t) return;
    const [w, h] = this.win.getContentSize();
    // Hide the toolbar (address bar) ONLY on the homepage tab — its full-page UI
    // covers y=40 down. Every other tab, INCLUDING profile 0's team tabs, keeps
    // the address bar (主人令: profile 0 的地址栏不再隐藏 / 不限制).
    const top = t.home ? STRIP_H : CHROME_H;
    try { t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) }); } catch (e) {}
  }

  addTab(url, opts = {}) {
    const target = (url && String(url).trim()) || startPageUrl(this.accountIdx);
    // reuse an existing tab with the same origin+pathname
    const key = url ? stripVol(target) : null;
    if (key) {
      const ex = this.tabs.find((t) => stripVol(t.url) === key);
      if (ex) { this.activate(ex.id); return ex.id; }
    }
    // Privilege gate: only the system profile (accountIdx 0) may get a Node-capable
    // preload / <webview>; all other profiles are forced to the sandbox baseline.
    const wp = buildTabWebPreferences(this.accountIdx, this.partition, target, opts);
    const view = new BrowserView({ webPreferences: wp });
    const wc = view.webContents;
    const id = wc.id;
    // BrowserView tabs aren't auto-covered by the global contextMenu() (it only
    // attaches to BrowserWindows + webviews), so give each tab exactly one
    // right-click menu (copy/paste/inspect) — without this, right-click did nothing.
    try { attachContextMenu(wc); } catch (e) {}
    // home = the resident homepage tab (pinned, first, user-icon, no close).
    // fixedTitle = a caller-supplied tab name (e.g. the team title) that the
    // page's own document.title must NOT override.
    const tab = { id, view, title: "", url: target, home: !!opts.home, fixedTitle: opts.title || "" };
    if (opts.home) this.tabs.unshift(tab); else this.tabs.push(tab);
    wc.on("page-title-updated", (_e, title) => { if (!tab.fixedTitle) { tab.title = title; this.pushState(); } });
    wc.on("page-favicon-updated", (_e, favs) => { tab.favicon = (favs && favs[0]) || ""; this.pushState(); });
    wc.on("did-start-loading", () => { tab.loading = true; this.pushState(); });
    wc.on("did-stop-loading", () => { tab.loading = false; this.pushState(); });
    // Re-sync fullscreen state after each (re)load: the SPA resets data-fullscreen
    // to "0" on mount, so a homepage reload while the window is fullscreen would
    // otherwise re-show the 34px traffic-light gutter (blank top strip).
    wc.on("did-finish-load", () => { try { wc.send("window:fullscreen", !!this.win.isFullScreen()); } catch (e) {} });
    wc.on("did-navigate", (_e, u) => { tab.url = u; tab.favicon = ""; this.pushState(); });
    wc.on("did-navigate-in-page", (_e, u) => { tab.url = u; this.pushState(); });
    // popups / window.open → open as a new tab. In profile 0 the new tab carries
    // the (inert) electronRPC bridge like any other profile-0 tab; its origin is
    // still gated by the rpc:guarded consent modal before any tool runs. Sandbox
    // profiles (accountIdx ≥ 1) never get the bridge, popup or not.
    try { wc.setWindowOpenHandler(({ url: u }) => {
      try { this.addTab(u); } catch (e) {}
      return { action: "deny" };
    }); } catch (e) {}
    wc.loadURL(target);
    this.activate(id);
    return id;
  }

  activate(id) {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return false;
    if (this.activeId != null && this.activeId !== id) {
      const cur = this.tabs.find((x) => x.id === this.activeId);
      if (cur) { try { this.win.removeBrowserView(cur.view); } catch (e) {} }
    }
    this.activeId = id;
    try { this.win.addBrowserView(t.view); } catch (e) {}
    this.layout();
    this.pushState();
    return true;
  }

  close(id) {
    const i = this.tabs.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const t = this.tabs[i];
    if (t.home) return false; // the resident homepage tab can't be closed
    try { this.win.removeBrowserView(t.view); } catch (e) {}
    try { t.view.webContents.close(); } catch (e) { try { t.view.webContents.destroy(); } catch (_) {} }
    this.tabs.splice(i, 1);
    if (this.activeId === id) {
      this.activeId = null;
      const n = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (n) this.activate(n.id);
      else if (this.accountIdx !== 0) this.addTab(); // non-system: keep a start page
      else this.pushState(); // profile 0: leave empty (tabs only come from homepage)
    } else {
      this.pushState();
    }
    return true;
  }

  list() { return this.tabs.map((t) => ({ webContentsId: t.id, title: t.title, url: t.url, active: t.id === this.activeId })); }

  activeWc() { const t = this.tabs.find((x) => x.id === this.activeId); return t ? t.view.webContents : null; }
}

function ensureManager(accountIdx) {
  let m = managers.get(accountIdx);
  if (m && !m.win.isDestroyed()) return m;
  m = new TabManager(accountIdx);
  managers.set(accountIdx, m);
  return m;
}

function findManagerByTab(webContentsId) {
  for (const m of managers.values()) {
    if (m.tabs.some((t) => t.id === webContentsId)) return m;
  }
  return null;
}

// ── programmatic API (team-open reroute / homepage) ──────────────────────────
// profile 0 is the system tab window. It used to accept tabs ONLY from the
// homepage (team open, systemOpen:true); that restriction is lifted so the "+"
// button / electron_tab_open / the panel can add tabs to profile 0 too.
async function openTab(accountIdx, url, opts = {}) {
  const m = ensureManager(accountIdx);
  const id = m.addTab(url, { trusted: !!opts.trusted, home: !!opts.home, title: opts.title || "" });
  try { m.win.show(); m.win.focus(); } catch (e) {}
  return { winId: m.win.id, accountIdx, tabId: id };
}
// Open (or focus) the resident homepage tab of a profile's tab window. Returns
// { win, wc } so the homepage module can track the tab's webContents for the
// main→renderer pushes (auth:complete, update-state) that used to target the
// standalone homepage window.
function openHomeWindow(accountIdx, homeUrl) {
  const m = ensureManager(accountIdx);
  let tab = m.tabs.find((t) => t.home);
  if (tab) { m.activate(tab.id); }
  else { const id = m.addTab(homeUrl, { home: true }); tab = m.tabs.find((t) => t.id === id); }
  try { m.win.show(); m.win.focus(); } catch (e) {}
  let wc = null; try { wc = tab ? tab.view.webContents : null; } catch (e) {}
  return { win: m.win, wc };
}

// ── shell IPC (registered once) ──────────────────────────────────────────────
let ipcInstalled = false;
function installIpc() {
  if (ipcInstalled) return;
  ipcInstalled = true;
  const mgr = (e) => managerByHost.get(e.sender.id);
  ipcMain.on("tabwin:ready", (e) => { const m = mgr(e); if (m) m.pushState(); });
  ipcMain.on("tabwin:new", (e, { url }) => { const m = mgr(e); if (m) m.addTab(url || ""); });
  ipcMain.on("tabwin:activate", (e, { id }) => { const m = mgr(e); if (m) m.activate(id); });
  ipcMain.on("tabwin:close", (e, { id }) => { const m = mgr(e); if (m) m.close(id); });
  ipcMain.on("tabwin:navigate", (e, { url }) => { const m = mgr(e); const wc = m && m.activeWc(); if (wc && url) wc.loadURL(String(url)); });
  ipcMain.on("tabwin:back", (e) => { const m = mgr(e); const wc = m && m.activeWc(); if (wc && wc.canGoBack()) wc.goBack(); });
  ipcMain.on("tabwin:fwd", (e) => { const m = mgr(e); const wc = m && m.activeWc(); if (wc && wc.canGoForward()) wc.goForward(); });
  ipcMain.on("tabwin:reload", (e) => { const m = mgr(e); const wc = m && m.activeWc(); if (wc) wc.reload(); });
}
installIpc();

// CDP captureScreenshot — works for background tabs (capturePage blanks when the
// BrowserView isn't the attached/visible one).
async function tabScreenshot(webContentsId, format) {
  const wc = webContents.fromId(webContentsId);
  if (!wc) throw new Error(`tab ${webContentsId} not found`);
  const fmt = format === "png" ? "png" : "jpeg";
  let attached = false;
  try {
    try { wc.debugger.attach("1.3"); attached = true; } catch (e) {}
    const res = await wc.debugger.sendCommand("Page.captureScreenshot", { format: fmt, quality: 70 });
    return `data:image/${fmt};base64,${res.data}`;
  } finally {
    if (attached) { try { wc.debugger.detach(); } catch (e) {} }
  }
}

function registerTabBrowserTools(registerTool) {
  const ok = (obj, isErr = false) => ({
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    ...(isErr ? { isError: true } : {}),
  });

  registerTool(
    "electron_tabwin_open",
    "打开/前置某 profile 的标签浏览器窗口（一个 profile 一个窗口，accountIdx → persist:sandbox-N，BrowserView tab）。",
    z.object({ accountIdx: z.number().describe("账户索引（profile）") }),
    async ({ accountIdx }) => {
      try {
        const m = ensureManager(accountIdx);
        if (m.tabs.length === 0 && accountIdx !== 0) m.addTab();
        try { m.win.show(); m.win.focus(); } catch (e) {}
        return ok({ success: true, accountIdx, winId: m.win.id });
      } catch (e) { return ok({ error: e.message }, true); }
    },
    { tag: "TabBrowser" }
  );

  registerTool(
    "electron_tab_open",
    "在某 profile 的标签窗口新开一个标签（窗口不在则先建）。打开=开 tab,不弹新窗口。trusted=true 给 cicy-code 等受信任页注入 electronRPC 桥。",
    z.object({
      accountIdx: z.number().describe("账户索引（profile）"),
      url: z.string().optional().describe("网址；省略则起始页"),
      trusted: z.boolean().optional().describe("受信任页面才注入桥；默认 false"),
    }),
    async ({ accountIdx, url, trusted }) => {
      try {
        const r = await openTab(accountIdx, url, { trusted: !!trusted });
        return ok({ success: true, accountIdx, winId: r.winId, tabId: r.tabId, tabs: ensureManager(accountIdx).list() });
      } catch (e) { return ok({ error: e.message }, true); }
    },
    { tag: "TabBrowser" }
  );

  registerTool(
    "electron_tabs",
    "列出某 profile 标签窗口的所有标签（每个 = 一个 webContentsId，可单独控制，像 Chrome target）。",
    z.object({ accountIdx: z.number().describe("账户索引（profile）") }),
    async ({ accountIdx }) => {
      try {
        const m = managers.get(accountIdx);
        return ok({ accountIdx, tabs: m && !m.win.isDestroyed() ? m.list() : [] });
      } catch (e) { return ok({ error: e.message }, true); }
    },
    { tag: "TabBrowser" }
  );

  registerTool(
    "electron_tab_navigate",
    "让某个标签（按 webContentsId）导航到一个网址。",
    z.object({ webContentsId: z.number(), url: z.string() }),
    async ({ webContentsId, url }) => {
      try {
        const wc = webContents.fromId(webContentsId);
        if (!wc) throw new Error(`tab ${webContentsId} not found`);
        await wc.loadURL(String(url));
        return ok({ success: true, webContentsId, url });
      } catch (e) { return ok({ error: e.message }, true); }
    },
    { tag: "TabBrowser" }
  );

  registerTool(
    "electron_tab_eval",
    "在某个标签（按 webContentsId）的页面执行 JS 并返回结果。",
    z.object({ webContentsId: z.number(), code: z.string() }),
    async ({ webContentsId, code }) => {
      try {
        const wc = webContents.fromId(webContentsId);
        if (!wc) throw new Error(`tab ${webContentsId} not found`);
        const result = await wc.executeJavaScript(String(code), true);
        return ok({ success: true, webContentsId, result });
      } catch (e) { return ok({ error: e.message }, true); }
    },
    { tag: "TabBrowser" }
  );

  registerTool(
    "electron_tab_screenshot",
    "截取某个标签（按 webContentsId）。走 CDP，后台标签也能截。",
    z.object({ webContentsId: z.number(), format: z.enum(["png", "jpeg"]).optional().default("jpeg") }),
    async ({ webContentsId, format }) => {
      try {
        const dataUrl = await tabScreenshot(webContentsId, format);
        return ok({ success: true, webContentsId, format, base64: dataUrl });
      } catch (e) { return ok({ error: e.message }, true); }
    },
    { tag: "TabBrowser" }
  );

  registerTool(
    "electron_tab_activate",
    "把某个标签（按 webContentsId）切到前台。",
    z.object({ webContentsId: z.number() }),
    async ({ webContentsId }) => {
      try {
        const m = findManagerByTab(webContentsId);
        if (!m) throw new Error(`tab ${webContentsId} not found`);
        return ok({ success: m.activate(webContentsId), webContentsId });
      } catch (e) { return ok({ error: e.message }, true); }
    },
    { tag: "TabBrowser" }
  );

  registerTool(
    "electron_tab_close",
    "关闭某个标签（按 webContentsId）。",
    z.object({ webContentsId: z.number() }),
    async ({ webContentsId }) => {
      try {
        const m = findManagerByTab(webContentsId);
        if (!m) throw new Error(`tab ${webContentsId} not found`);
        return ok({ success: m.close(webContentsId), webContentsId });
      } catch (e) { return ok({ error: e.message }, true); }
    },
    { tag: "TabBrowser" }
  );
}

// Reload the profile-N tab whose URL matches (origin+pathname); if none is open,
// open it. Used by the homepage cloud-team card's ⋯ "刷新窗口".
async function reloadTabByUrl(accountIdx, url, opts = {}) {
  const m = managers.get(accountIdx);
  if (m && !m.win.isDestroyed()) {
    const key = stripVol(url);
    const tab = m.tabs.find((t) => stripVol(t.url) === key);
    if (tab) {
      try { tab.view.webContents.reload(); } catch (e) {}
      try { m.activate(tab.id); m.win.show(); m.win.focus(); } catch (e) {}
      return { ok: true, winId: m.win.id, reloaded: true };
    }
  }
  const r = await openTab(accountIdx, url, { systemOpen: true, trusted: !!opts.trusted, title: opts.title || "" });
  return { ok: true, winId: r.winId, opened: true };
}

registerTabBrowserTools.openTab = openTab;
registerTabBrowserTools.reloadTabByUrl = reloadTabByUrl;
registerTabBrowserTools.openHomeWindow = openHomeWindow;
registerTabBrowserTools.ensureManager = ensureManager;
module.exports = registerTabBrowserTools;
