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
const { BrowserView, ipcMain, net, webContents, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadPanelCellUrl } = require("./telegram-web-preferences");
const { shouldAttachPanelCell } = require("./panel-cell-visibility");

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
const telegramIdentity = require("./telegram-identity");
const facebookIdentity = require("./facebook-identity");
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

async function applyProfileProxy(idx, proxy) {
  const part = partitionFor(idx);
  const rules = require("../profiles/profile-store").proxyRules(proxy);
  await session.fromPartition(part).setProxy({
    proxyRules: rules || "direct://",
    proxyBypassRules: "127.0.0.1,localhost,[::1]",
  });
  appliedProxy.add(part);
  for (const pc of registry.values()) {
    for (const rec of pc.views.values()) {
      if (rec.profile === idx) {
        try { rec.view.webContents.reload(); } catch (e) {}
      }
    }
  }
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
    const rec = { view, url: "", profile: profileIdx, visible: true, identity: null };
    try { view.setBackgroundColor("#ffffff"); } catch (e) {}
    // Chromium uses a dark canvas for transparent/un-styled documents when the
    // app theme is dark (for example a plain `Not Found` response). Keep real
    // site backgrounds intact, but give transparent pages a white fallback.
    wc.on("dom-ready", () => {
      wc.executeJavaScript(`(() => {
        const transparent = (el) => {
          const c = getComputedStyle(el).backgroundColor;
          return c === 'transparent' || /rgba\\([^)]*,\\s*0(?:\\.0+)?\\)$/.test(c);
        };
        if (transparent(document.documentElement) && transparent(document.body)) {
          document.documentElement.style.backgroundColor = '#fff';
        }
      })()`).catch(() => {});
    });
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
    // 最近一次加载失败(did-fail-load)——面板页据此显示「代理不通/网络错误」覆盖层,而不是
    // 一片白(chrome-error:// 页在深色主题下就是空白)。成功导航后清空。
    let lastError = null;
    const push = () => {
      let url = "", title = "";
      try { url = wc.getURL(); title = wc.getTitle(); } catch (e) {}
      // did-navigate / page-title-updated commonly fire while the document is
      // still loading. Hard-coding false here hid the spinner immediately after
      // did-start-loading; report the BrowserView's actual state instead.
      let loading = false;
      try { loading = wc.isLoading(); } catch (e) {}
      const failed = /^chrome-error:/.test(url) || !!lastError;
      this.sendState({ id: cellId, url, title, loading, wcId: wc.id, failed, error: failed ? lastError : null, identity: rec.identity || null });
    };
    // Telegram Web 是 PWA:代理挂掉时 service worker 照样从缓存吐出 app shell,主框架
    // 「加载成功」、did-fail-load 不触发,可页面其实一点网都没有(用户看到的就是一片白
    // 或永远转圈)。实测:profile 代理指向一个没人监听的端口,状态仍显示「已加载」。
    // 所以加载结束后再从 session 层探一次真实连通性 —— net.fetch 走这个 session 的代理,
    // 且完全绕开 service worker 缓存,是唯一能分辨「真加载」和「缓存假象」的办法。
    let probeSeq = 0;
    const probeReachable = async () => {
      if (profileIdx === 0) return; // 本地 cicy-code,不走代理也没 SW 缓存问题
      const seq = ++probeSeq;
      let target = "";
      // 探文档本身,不探 favicon:favicon 在某些代理链路上会挂住(实测 mihomo 下
      // ERR_CONNECTION_TIMED_OUT),而文档 URL 正是页面刚刚请求过的那一个。
      try { const u = new URL(wc.getURL()); if (/^https?:$/.test(u.protocol)) target = `${u.origin}${u.pathname}`; } catch (e) {}
      if (!target) return;
      const attempt = async () => {
        try {
          await net.fetch(target, {
            session: session.fromPartition(partitionFor(profileIdx)),
            cache: "no-store",
            signal: AbortSignal.timeout(10000),
          });
          return "";
        } catch (e) { return String((e && e.message) || e) || "请求失败"; }
      };
      // 一次失败不算数:代理抖一下就报「连接失败」比不报还烦。两次都失败才判定。
      let detail = await attempt();
      if (detail) {
        if (seq !== probeSeq) return;
        await new Promise((r) => setTimeout(r, 2000));
        if (seq !== probeSeq) return;
        detail = await attempt();
      }
      if (seq !== probeSeq) return;       // 期间又导航了,这次结果作废
      if (!detail) return;                 // 通了就什么都不做(别覆盖真正的 did-fail-load)
      lastError = { code: "ERR_NO_NETWORK", description: `网络不可达（${detail}）；页面内容来自缓存`, url: target };
      try { wc.cicyLastError = lastError; } catch (e) {}
      push();
    };

    // Telegram 身份:登录后从页面自己的 localStorage/IndexedDB 读出 @username,写进
    // profile 的 logins(name=telegram),并推给面板列表。登录流程刚结束时用户表可能
    // 还没落库,所以延迟探几次;拿到就停。
    let identSeq = 0;
    const detectIdentity = () => {
      if (profileIdx === 0) return;
      let url = ""; try { url = wc.getURL(); } catch (e) {}
      // 站点 → 身份模块(Telegram Web K / Facebook);其他站点不探。
      const site = telegramIdentity.isTelegramUrl(url) ? telegramIdentity : facebookIdentity.isFacebookUrl(url) ? facebookIdentity : null;
      if (!site) return;
      const script = site === telegramIdentity ? telegramIdentity.TELEGRAM_IDENTITY_SCRIPT : facebookIdentity.FACEBOOK_IDENTITY_SCRIPT;
      const normalize = site === telegramIdentity ? telegramIdentity.normalizeTelegramIdentity : facebookIdentity.normalizeFacebookIdentity;
      const record = site === telegramIdentity ? telegramIdentity.telegramLoginRecord : facebookIdentity.facebookLoginRecord;
      const seq = ++identSeq;
      const delays = [2500, 8000, 20000, 45000];
      const tick = async (i) => {
        if (seq !== identSeq || wc.isDestroyed()) return;
        let raw = null;
        try { raw = await wc.executeJavaScript(script, true); } catch (e) {}
        const it = normalize(raw);
        if (seq !== identSeq) return;
        if (it && (it.username || it.displayName || it.phone)) {
          const prev = rec.identity;
          rec.identity = it;
          if (!prev || prev.username !== it.username || prev.displayName !== it.displayName || prev.phone !== it.phone) {
            try { require("../profiles/profile-store").setLogin("electron", profileIdx, record(it)); } catch (e) {}
            this.sendState({ id: cellId, wcId: wc.id, identity: it, loading: false, url, title: (() => { try { return wc.getTitle(); } catch (e) { return ""; } })() });
          }
          return;
        }
        if (i + 1 < delays.length) setTimeout(() => tick(i + 1), delays[i + 1]);
      };
      setTimeout(() => tick(0), delays[0]);
    };

    wc.on("did-start-loading", () => { probeSeq++; identSeq++; this.sendState({ id: cellId, loading: true, wcId: wc.id }); });
    wc.on("did-stop-loading", () => { push(); probeReachable(); detectIdentity(); });
    wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3) return; // 子框架 / ERR_ABORTED(用户导航打断)不算失败
      lastError = { code: errorCode, description: String(errorDescription || ""), url: String(validatedURL || "") };
      try { wc.cicyLastError = lastError; } catch (e) {}
      push();
    });
    wc.on("did-navigate", (_e, navUrl) => { if (!/^chrome-error:/.test(String(navUrl || ""))) { lastError = null; try { wc.cicyLastError = null; } catch (e) {} } });
    wc.on("did-navigate", push);
    wc.on("did-navigate-in-page", push);
    wc.on("page-title-updated", push);

    rec.view = view;
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
      rec.visible = c.visible !== false;
      if (url && rec.url !== url) {
        rec.url = url;
        try { loadPanelCellUrl(rec.view.webContents, url).catch(() => {}); } catch (e) {}
      }
      this.place(rec, c.rect);
    }
    for (const key of [...this.views.keys()]) if (!seen.has(key)) this.destroyCell(key);
    this.updateAttach();
  }

  // 当前所有格子的加载状态(页面刷新后重新拿一遍,否则已加载/已失败的格子不会再发事件)。
  states() {
    const out = [];
    for (const [id, rec] of this.views) {
      const wc = rec.view && rec.view.webContents;
      if (!wc || wc.isDestroyed()) continue;
      let url = "", title = "", loading = false;
      try { url = wc.getURL(); title = wc.getTitle(); loading = wc.isLoading(); } catch (e) {}
      out.push({ id, url, title, loading, wcId: wc.id, failed: /^chrome-error:/.test(url), error: wc.cicyLastError || null, identity: rec.identity || null });
    }
    return out;
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
        if (shouldAttachPanelCell(this.visible, rec.visible)) win.addBrowserView(rec.view);   // no-op if already attached
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
  ipcMain.handle("panelcells:states", (e) => { const pc = ctx(e); return pc ? pc.states() : []; });
  ipcMain.handle("panelcells:profiles", (e) => {
    if (!ctx(e)) return [];
    try {
      return require("../profiles/profile-store").listProfiles("electron")
        .filter((p) => Number.isInteger(Number(p.accountIdx)) && Number(p.accountIdx) > 0 && Number(p.accountIdx) !== 9)
        .map((p) => ({
          accountIdx: Number(p.accountIdx),
          name: String(p.name || ""),
          proxy: p.proxy && p.proxy.enabled ? String(p.proxy.url || "") : "",
          note: String(p.note || ""),
          telegram: telegramIdentity.telegramIdentityFromProfile(p),
          facebook: facebookIdentity.facebookIdentityFromProfile(p),
          ipInfo: p.ipInfo && p.ipInfo.ip ? { ip: String(p.ipInfo.ip), area: String(p.ipInfo.area || ""), probedAt: String(p.ipInfo.probedAt || "") } : null,
        }));
    } catch (err) { return []; }
  });
  ipcMain.handle("panelcells:add-profile", async (e) => {
    if (!ctx(e)) throw new Error("Invalid panel");
    const service = require("./telegram-matrix-profiles");
    const profile = service.addTelegramProfile();
    await applyProfileProxy(profile.accountIdx, profile.proxy);
    return { accountIdx: profile.accountIdx, name: profile.name, proxy: profile.proxy.url };
  });
  ipcMain.handle("panelcells:set-profile-proxy", async (e, { accountIdx, proxy }) => {
    if (!ctx(e)) throw new Error("Invalid panel");
    const service = require("./telegram-matrix-profiles");
    const profile = service.setTelegramProfileProxy(accountIdx, proxy);
    await applyProfileProxy(profile.accountIdx, profile.proxy);
    return { accountIdx: profile.accountIdx, name: profile.name, proxy: profile.proxy.url };
  });
  // 出口 IP / 地区:经该 profile 的 session(=它的代理)去问 IP 服务,结果写回 profile.ipInfo。
  ipcMain.handle("panelcells:probe-ip", async (e, { accountIdx }) => {
    if (!ctx(e)) throw new Error("Invalid panel");
    const id = Number(accountIdx);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid Electron profile ID");
    const profileStore = require("../profiles/profile-store");
    const { probeIpViaSession } = require("../utils/ip-probe");
    const part = partitionFor(id);
    // 没打开过的 profile 其 session 还没配代理,会探成本机 IP —— 先按存储的代理配好。
    if (!appliedProxy.has(part)) {
      const prof = profileStore.getProfile("electron", id);
      const rules = profileStore.proxyRules(prof && prof.proxy);
      await session.fromPartition(part).setProxy({ proxyRules: rules || "direct://", proxyBypassRules: "127.0.0.1,localhost,[::1]" });
      appliedProxy.add(part);
    }
    const info = await probeIpViaSession(session.fromPartition(part));
    if (!info.ip) return { accountIdx: id, ipInfo: null, error: "探测失败：代理不通或 IP 服务不可达" };
    const view = profileStore.setIpInfo("electron", id, info);
    return { accountIdx: id, ipInfo: view.ipInfo };
  });
  // 删除 profile:关掉所有面板里该 profile 的视图,清空其 session 存储(登录态、cookie),
  // 再删记录。页面侧已二次确认。
  ipcMain.handle("panelcells:remove-profile", async (e, { accountIdx }) => {
    if (!ctx(e)) throw new Error("Invalid panel");
    const id = Number(accountIdx);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid Electron profile ID");
    for (const pc of registry.values()) {
      for (const [key, rec] of [...pc.views]) { if (rec.profile === id) pc.destroyCell(key); }
    }
    const part = partitionFor(id);
    try { await session.fromPartition(part).clearStorageData(); } catch (err) {}
    try { await session.fromPartition(part).clearCache(); } catch (err) {}
    appliedProxy.delete(part);
    const removed = require("../profiles/profile-store").removeProfile("electron", id);
    return { accountIdx: id, removed };
  });
  ipcMain.handle("panelcells:set-profile-note", async (e, { accountIdx, note }) => {
    if (!ctx(e)) throw new Error("Invalid panel");
    const id = Number(accountIdx);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid Electron profile ID");
    const text = String(note || "").trim().slice(0, 500);
    const profile = require("../profiles/profile-store").setNote("electron", id, text);
    return { accountIdx: id, note: String(profile.note || "") };
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
