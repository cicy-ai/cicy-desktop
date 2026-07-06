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

// 团队 tab 的 webContentsId 状态表:openTab 时记入、对应 webContents destroy 时删除
// (打开/关闭都更新)。刷新窗口据此按 wcId 强制 reload(reloadIgnoringCache),避开
// "tab 打开后 URL 漂移(登录跳转 / token / 重定向)→ 按 URL 匹配失败"的 bug。
// 键 = stripVol(打开时传入的 url);open 与 reload 两端 stripVol 一致(token 被剥掉)。
const openedWc = new Map(); // stripVol(url) -> webContentsId

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
      // sandbox:false —— shell 是我们自己的可信 chrome(标签条/工具栏),它的 preload
      // 需要 require("../i18n")(fs/path/i18next)。不显式关沙箱的话现代 Electron 默认
      // 开沙箱,require 会抛错 → tab-shell-preload 的 __i18n=null → tabAPI.t 永远只回
      // fallback(实测「我的团队/新建标签」不走 i18n 的根因)。与 homepage 窗口一致。
      webPreferences: { preload: SHELL_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
    };
    try { winOpts.icon = require("../utils/app-icon").appIconPath(); } catch (e) {}
    // 新开的非 0 profile 窗口相对原 profile(优先 profile 0)做级联偏移,避免完全压在
    // 原窗口上(cicy-ai / 点开的链接都开在 profile 1,叠在 profile 0 上会看不出是新窗口)。
    if (accountIdx !== 0) {
      try {
        const ref = managers.get(0) || [...managers.values()].find((m) => m && m.win && !m.win.isDestroyed());
        if (ref && ref.win && !ref.win.isDestroyed()) {
          const [rx, ry] = ref.win.getPosition();
          const OFF = 48 * accountIdx;
          winOpts.x = rx + OFF;
          winOpts.y = ry + OFF;
        }
      } catch (e) {}
    }
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
        avatar: t.avatar || "",   // team 自定义头像 → tab icon 用它(优先于页面 favicon)
        team: !!t.team,           // 团队 tab:icon 只用 avatar,禁用页面 favicon
        colorKey: t.colorKey || "", // 无头像时首字母色块的底色种子 = teamId(和卡片一致)
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
    // the address bar (profile 0 的地址栏不再隐藏 / 不限制).
    const top = t.home ? STRIP_H : CHROME_H;
    try { t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) }); } catch (e) {}
  }

  addTab(url, opts = {}) {
    const target = (url && String(url).trim()) || startPageUrl(this.accountIdx);
    // reuse an existing tab with the same origin+pathname
    const key = url ? stripVol(target) : null;
    if (key) {
      const ex = this.tabs.find((t) => stripVol(t.url) === key);
      if (ex) {
        // navigate-on-reuse:同 origin+pathname 但完整 URL(含 query)不同时,把已有 tab
        // 导航过去。cicy-ai 的 我的钱包/我的帐单/团队帐单 都在 /dash、只差 query —— 不导航
        // 就会命中同一个 /dash tab 却不切视图(点了帐单还显示钱包)。仅 navigate 选项启用,
        // 团队 tab(stripVol 防 token 漂移、不重载)行为不变。
        if (opts.navigate && ex.url !== target) {
          try { ex.view.webContents.loadURL(target); ex.url = target; } catch (e) {}
        }
        this.activate(ex.id); return ex.id;
      }
    }
    // Privilege gate: only the system profile (accountIdx 0) may get a Node-capable
    // preload / <webview>; all other profiles are forced to the sandbox baseline.
    const wp = buildTabWebPreferences(this.accountIdx, this.partition, target, opts);
    const view = new BrowserView({ webPreferences: wp });
    const wc = view.webContents;
    const id = wc.id;
    // Tag the tab's webContents with its profile so anything holding just the wc
    // (context menu, window helpers) can resolve the REAL profile deterministically.
    // BrowserView guests don't expose a readable partition (session.partition and
    // getWebPreferences().partition both come back empty), so this tag — set from
    // the owning TabManager's accountIdx — is the only reliable source.
    try { wc.cicyAccountIdx = this.accountIdx; } catch (e) {}
    // BrowserView tabs aren't auto-covered by the global contextMenu() (it only
    // attaches to BrowserWindows + webviews), so give each tab exactly one
    // right-click menu (copy/paste/inspect) — without this, right-click did nothing.
    try { attachContextMenu(wc); } catch (e) {}
    // Buffer this tab's console (keyed by its webContents.id) so
    // get_tab_console_logs(<wcId>) can read it — window-monitor only listens on
    // BrowserWindow main webContents, never BrowserView tabs.
    try { require("../utils/window-monitor").attachTabConsole(wc); } catch (e) {}
    // home = the resident homepage tab (pinned, first, user-icon, no close).
    // fixedTitle = a caller-supplied tab name (e.g. the team title) that the
    // page's own document.title must NOT override.
    const tab = { id, view, title: "", url: target, home: !!opts.home, fixedTitle: opts.title || "", avatar: opts.avatar || "", team: !!opts.team, colorKey: opts.colorKey || "" };
    // team tab 用团队自定义头像做 icon:调用方没给就按 URL 反查 teams.json(覆盖所有打开路径)。
    if (!tab.avatar && !opts.home) { try { tab.avatar = require("../backends/local-teams").avatarForUrl(target) || ""; } catch (e) {} }
    if (opts.home) this.tabs.unshift(tab); else this.tabs.push(tab);
    wc.on("page-title-updated", (_e, title) => { if (!tab.fixedTitle) { tab.title = title; this.pushState(); } });
    wc.on("page-favicon-updated", (_e, favs) => { tab.favicon = (favs && favs[0]) || ""; this.pushState(); });
    wc.on("did-start-loading", () => { tab.loading = true; this.pushState(); });
    wc.on("did-stop-loading", () => { tab.loading = false; try { const cu = wc.getURL(); if (cu && !cu.startsWith("about:blank")) tab.url = cu; } catch (e) {} this.pushState(); });
    // Re-sync fullscreen state after each (re)load: the SPA resets data-fullscreen
    // to "0" on mount, so a homepage reload while the window is fullscreen would
    // otherwise re-show the 34px traffic-light gutter (blank top strip).
    wc.on("did-finish-load", () => { try { wc.send("window:fullscreen", !!this.win.isFullScreen()); } catch (e) {} });
    // **绝不把 about:blank 记进 tab.url**。这些 tab 从不真的停在 about:blank —— 但新建时会先
    // 短暂经过 about:blank,导航事件的 u 偶尔就是 about:blank(或 about:blank#hash,SPA 在空白页
    // 上先改了 hash)。若写进去,地址栏/tab 就显示 about:blank#teams,且任何「按 tab.url 重新导航」
    // 的 reload(reloadTabByUrl)会真把页面导到 about:blank#teams。忽略它,保留上一个真实 URL。
    wc.on("did-navigate", (_e, u) => { if (u && !u.startsWith("about:blank")) tab.url = u; tab.favicon = ""; this.pushState(); });
    wc.on("did-navigate-in-page", (_e, u) => { if (u && !u.startsWith("about:blank")) tab.url = u; this.pushState(); });
    // popups / window.open → open as a tab. 安全(防"点链接 = 静默 RCE"):在 profile 0
    // (系统/特权 profile,tab 带 electronRPC 桥)里被点开的链接 —— 典型是 agent gotty
    // 打印的网址 —— 一律改到 profile 1 打开。profile 1 是硬沙箱(contextIsolation on /
    // nodeIntegration off / sandbox on / 无 preload),永远拿不到桥,外部站点零桌面 RPC 面。
    // 这点尤其关键:localhost/127.0.0.1 在内置白名单里(isTrustedUrl=true → origin gate 免
    // 弹窗),若落在带桥的 profile 0,攻击者本地端口页可静默调用所有非 exec/file 工具。
    // 沙箱 profile(accountIdx ≥ 1)自身的 window.open 本就没有桥,仍开成本 profile 的 tab。
    try { wc.setWindowOpenHandler(({ url: u }) => {
      try {
        if (this.accountIdx === 0) openTab(1, u); // 特权 profile 的链接 → 沙箱 profile 1
        else this.addTab(u);                      // 沙箱 profile → 本 profile 内开 tab
      } catch (e) {}
      return { action: "deny" };
    }); } catch (e) {}
    // 同上的安全考虑,but for 原地导航(will-navigate):profile 0 的特权 tab 若被(页面
    // 自身 location 跳转 / 重定向 / 点链接)导航到**跨源**地址,preventDefault 并踢到
    // profile 1 沙箱打开,绝不让带桥的 profile 0 tab 落到外部/localhost 站点。同源导航
    // (应用自身路由,如团队 app /login→/dash)放行;about: 等放行;解析失败不拦。
    // will-navigate 只管主框架顶层导航,不影响 SPA in-page(pushState)或子资源/iframe。
    if (this.accountIdx === 0) {
      wc.on("will-navigate", (e, u) => {
        try {
          let tgt; try { tgt = new URL(u); } catch { return; }
          if (tgt.protocol === "about:") return;
          let curOrigin = ""; try { curOrigin = new URL(wc.getURL()).origin; } catch {}
          if (tgt.origin !== curOrigin) { e.preventDefault(); openTab(1, u); }
        } catch (err) {}
      });
    }
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

  // 让窗口「可见但不抢前台」:已显示 → 什么都不做;隐藏 → showInactive(绝不 focus)。
  // 程序化/agent 驱动的开 tab、reload、activate 都用它 —— win.focus() 只有在 cicy-desktop 不
  // 在前台时才有效(= 从用户当前 app 抢焦点),用户在 cicy-desktop 内操作时它本就是 no-op。
  // 所以这些非「用户明确要打开 app」的路径一律不抢焦点,避免用户在微信等窗口时被莫名跳到前台。
  surfaceQuiet() { try { if (!this.win.isVisible()) this.win.showInactive(); } catch (e) {} }

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

  // Chrome-style drag reorder. `orderedIds` is the desired order of the NON-home
  // tabs (the resident homepage tab stays pinned first regardless). Unknown/missing
  // ids are ignored; any movable tab not named keeps its relative order at the end.
  reorder(orderedIds) {
    if (!Array.isArray(orderedIds)) return false;
    const home = this.tabs.filter((t) => t.home);
    const movable = this.tabs.filter((t) => !t.home);
    const byId = new Map(movable.map((t) => [t.id, t]));
    const next = [];
    for (const id of orderedIds) { const t = byId.get(id); if (t && !next.includes(t)) next.push(t); }
    for (const t of movable) { if (!next.includes(t)) next.push(t); } // keep any unnamed tabs
    this.tabs = [...home, ...next];
    this.pushState();
    return true;
  }

  // Reload the tab whose URL matches (origin+pathname) IN PLACE — used by the
  // homepage team card's 刷新窗口 / 更新后自动刷. ignoreCache → reloadIgnoringCache
  // (re-fetch new assets after a cicy-code update, not the cached index.html).
  // Returns true iff a matching tab was found+reloaded; NEVER opens a new tab.
  reloadTabByUrlInPlace(url, { ignoreCache = false } = {}) {
    const key = stripVol(url);
    const tab = this.tabs.find((t) => stripVol(t.url) === key);
    if (!tab) return false;
    try {
      if (ignoreCache) tab.view.webContents.reloadIgnoringCache();
      else tab.view.webContents.reload();
    } catch (e) {}
    try { this.activate(tab.id); this.surfaceQuiet(); } catch (e) {}
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
  const id = m.addTab(url, { trusted: !!opts.trusted, home: !!opts.home, title: opts.title || "", navigate: !!opts.navigate, avatar: opts.avatar || "", team: !!opts.team, colorKey: opts.colorKey || "" });
  try { m.surfaceQuiet(); } catch (e) {}
  // 记下这个团队 tab 的 webContentsId(打开 → set;关闭/销毁 → delete)。
  try {
    const tab = m.tabs.find((t) => t.id === id);
    const wc = tab && tab.view && tab.view.webContents;
    if (wc) {
      const key = stripVol(url);
      openedWc.set(key, wc.id);
      wc.once("destroyed", () => { if (openedWc.get(key) === wc.id) openedWc.delete(key); });
    }
  } catch (e) {}
  return { winId: m.win.id, accountIdx, tabId: id };
}
// Open (or focus) the resident homepage tab of a profile's tab window. Returns
// { win, wc } so the homepage module can track the tab's webContents for the
// main→renderer pushes (auth:complete, update-state) that used to target the
// standalone homepage window.
function openHomeWindow(accountIdx, homeUrl, opts = {}) {
  const m = ensureManager(accountIdx);
  let tab = m.tabs.find((t) => t.home);
  if (tab) {
    // 只在明确要求(用户点「打开首页」/ 启动)时才切到首页 tab。deeplink / second-instance 等
    // **顺带**触发 openHomepage 的路径传 activate:false —— 绝不抢走用户正在看的团队 tab,否则
    // 对话着对话着窗口就莫名切到「我的团队」(用户报的 bug)。当前本来就是首页 tab、或还没有任何
    // active tab 时,activate 无副作用,照常执行。
    if (opts.activate !== false || m.activeId == null || m.activeId === tab.id) m.activate(tab.id);
  } else {
    const id = m.addTab(homeUrl, { home: true }); tab = m.tabs.find((t) => t.id === id);
  }
  // 只有明确要求(tray「打开首页」/ 启动,activate!==false)才把窗口抢到前台;deeplink /
  // second-instance 顺带触发(activate:false)只静默显示,绝不从用户当前 app 抢焦点。
  if (opts.activate !== false) { try { m.win.show(); m.win.focus(); } catch (e) {} } else m.surfaceQuiet();
  let wc = null; try { wc = tab ? tab.view.webContents : null; } catch (e) {}
  return { win: m.win, wc };
}

// ── shell IPC (registered once) ──────────────────────────────────────────────
let ipcInstalled = false;
function installIpc() {
  if (ipcInstalled) return;
  ipcInstalled = true;
  const mgr = (e) => managerByHost.get(e.sender.id);
  ipcMain.on("tabwin:ready", (e) => {
    const m = mgr(e);
    if (!m) return;
    m.pushState();
    // 关键:shell 此刻已订阅好 onFullscreen,补发**当前**全屏状态。否则窗口若是全屏出生
    // (mac 上次全屏退出后再开,enter-full-screen 不触发)或事件早于订阅发出 → shell 收不到
    // → #tabs 卡在非全屏的 78px 红绿灯让位区 = 我的团队 tab 左边一大块空(实测 mac 全屏)。
    try { e.sender.send("window:fullscreen", !!m.win.isFullScreen()); } catch (err) {}
  });
  ipcMain.on("tabwin:new", (e, { url }) => { const m = mgr(e); if (m) m.addTab(url || ""); });
  ipcMain.on("tabwin:activate", (e, { id }) => { const m = mgr(e); if (m) m.activate(id); });
  ipcMain.on("tabwin:close", (e, { id }) => { const m = mgr(e); if (m) m.close(id); });
  ipcMain.on("tabwin:reorder", (e, { ids }) => { const m = mgr(e); if (m) m.reorder(ids); });
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
        try { m.surfaceQuiet(); } catch (e) {}
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

  registerTool(
    "get_tab_console_logs",
    "获取某个标签（按 webContentsId）的控制台日志：自该标签创建以来捕获的所有 console 输出（log/info/warning/error）。支持关键词/级别过滤、分页；最新在前。",
    z.object({
      webContentsId: z.number().describe("标签的 webContentsId"),
      page: z.number().optional().default(1).describe("页码，从 1 开始"),
      page_size: z.number().optional().default(50).describe("每页数量"),
      keyword: z.string().optional().describe("关键词过滤，匹配日志消息"),
      level: z.enum(["verbose", "info", "warning", "error"]).optional().describe("日志级别过滤"),
    }),
    async ({ webContentsId, page, page_size, keyword, level }) => {
      try {
        let logs = require("../utils/window-monitor").getTabConsoleLogs(webContentsId);
        if (keyword) logs = logs.filter((l) => l.message.includes(keyword));
        if (level) logs = logs.filter((l) => l.level === level);
        logs = [...logs].sort((a, b) => b.timestamp - a.timestamp);
        const start = (page - 1) * page_size;
        const paginated = logs.slice(start, start + page_size);
        const header = `Tab Console Logs (wc=${webContentsId}, ${logs.length} total, page ${page}/${Math.ceil(logs.length / page_size) || 1}):\n`;
        const lines = paginated.map((l) => {
          const time = new Date(l.timestamp).toISOString().replace("T", " ").substring(0, 23);
          const src = l.source ? ` (${String(l.source).split("/").pop()}:${l.line})` : "";
          return `${time} ${l.level.toUpperCase().padEnd(7)} ${String(l.message).replace(/\n/g, " ").substring(0, 200)}${src}`;
        });
        return { content: [{ type: "text", text: header + (lines.join("\n") || "(no console output)") }] };
      } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
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
      try { m.activate(tab.id); m.surfaceQuiet(); } catch (e) {}
      return { ok: true, winId: m.win.id, reloaded: true };
    }
  }
  const r = await openTab(accountIdx, url, { systemOpen: true, trusted: !!opts.trusted, title: opts.title || "" });
  return { ok: true, winId: r.winId, opened: true };
}

// Reload an OPEN team tab in `accountIdx`'s window, in place (no open-if-missing).
// Returns { ok:true, reloaded:true } if a matching tab was found, else
// { ok:false, error:"no_open_window" }. Used by local-teams.reloadTeam (profile 0).
function reloadTabIfOpen(accountIdx, url, opts = {}) {
  // 首选:按打开时记下的 webContentsId 强制 reload —— tab 打开后 URL 漂移也不怕。
  const key = stripVol(url);
  const wcId = openedWc.get(key);
  if (wcId != null) {
    const wc = webContents.fromId(wcId);
    if (wc && !wc.isDestroyed()) {
      try { wc.reloadIgnoringCache(); } catch (e) {}
      const mm = managers.get(accountIdx);
      if (mm && !mm.win.isDestroyed()) {
        try {
          const tab = mm.tabs.find((t) => { try { return t.view.webContents.id === wcId; } catch (e) { return false; } });
          if (tab) { mm.activate(tab.id); mm.surfaceQuiet(); }
        } catch (e) {}
      }
      return { ok: true, winId: mm ? mm.win.id : undefined, reloaded: true, byWcId: true };
    }
    openedWc.delete(key); // 已销毁 → 清状态
  }
  // 兜底:旧的按 URL 就地匹配,同样强制忽略缓存。
  const m = managers.get(accountIdx);
  if (!m || m.win.isDestroyed()) return { ok: false, error: "no_open_window" };
  return m.reloadTabByUrlInPlace(url, { ...opts, ignoreCache: true })
    ? { ok: true, winId: m.win.id, reloaded: true }
    : { ok: false, error: "no_open_window" };
}

// 只「激活(置前)」已打开的 tab,不 reload、不拿 token、不开新 tab —— 专给「打开很慢」
// 用:tab 已经开过就秒切过去(打开了直接 active 那个 tab 就行)。返回是否命中。
function activateTabIfOpen(accountIdx, url) {
  const key = stripVol(url);
  const wcId = openedWc.get(key);
  if (wcId != null) {
    const wc = webContents.fromId(wcId);
    if (wc && !wc.isDestroyed()) {
      const mm = managers.get(accountIdx);
      if (mm && !mm.win.isDestroyed()) {
        try {
          const tab = mm.tabs.find((t) => { try { return t.view.webContents.id === wcId; } catch (e) { return false; } });
          if (tab) { mm.activate(tab.id); mm.surfaceQuiet(); return { ok: true, active: true }; }
        } catch (e) {}
      }
    }
    openedWc.delete(key); // 已销毁 → 清状态
  }
  return { ok: false, active: false };
}

// 设头像后即时刷新已打开 tab 的 icon(否则要重开 tab 才变)。按 URL 反查 teams.json
// 的头像更新 tab.avatar 并 pushState。云端 tab(不在 teams.json)不在此列,需重开。
function refreshTabAvatars() {
  let lt; try { lt = require("../backends/local-teams"); } catch (e) { return; }
  for (const m of managers.values()) {
    let changed = false;
    for (const t of m.tabs) {
      if (t.home) continue;
      const a = lt.avatarForUrl(t.url) || "";
      if (a !== (t.avatar || "")) { t.avatar = a; changed = true; }
    }
    if (changed) try { m.pushState(); } catch (e) {}
  }
}
registerTabBrowserTools.refreshTabAvatars = refreshTabAvatars;
registerTabBrowserTools.openTab = openTab;
registerTabBrowserTools.reloadTabByUrl = reloadTabByUrl;
registerTabBrowserTools.reloadTabIfOpen = reloadTabIfOpen;
registerTabBrowserTools.activateTabIfOpen = activateTabIfOpen;
registerTabBrowserTools.openHomeWindow = openHomeWindow;
registerTabBrowserTools.ensureManager = ensureManager;
module.exports = registerTabBrowserTools;
