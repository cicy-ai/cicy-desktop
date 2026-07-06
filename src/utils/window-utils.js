// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const { app, BrowserWindow, Menu, shell } = require("electron");
const { default: contextMenu } = require("electron-context-menu");
const contextMenuOptions = require("./context-menu-options");
const path = require("path");
const fs = require("fs");
const os = require("os");
const log = require("electron-log");
const { config } = require("../config");
const { initWindowMonitoring } = require("./window-monitor");
const { loadWindowState, watchWindowState } = require("./window-state");
const { getWorkerIdentity } = require("../cluster/worker-identity");
const { createAgentId, createRuntimeSessionId, createWindowRef } = require("../cluster/types");

if (app) {
  app.name = "CiCy Desktop";
}

// Resolve the profile (accountIdx) a webContents lives in, from its session
// partition: persist:sandbox-N → N; the default/"" session → 0 (profile 0, the
// privileged/shared session). Mirrors getWindowInfo's derivation.
function partitionOfWebContents(wc) {
  // Electron's Session has NO readable `.partition`; the partition string lives on
  // the webContents' WebPreferences. Reading session.partition (always undefined)
  // made every profile resolve to 0. Prefer getWebPreferences(), fall back to
  // session.partition just in case.
  try {
    const wp = wc && wc.getWebPreferences ? wc.getWebPreferences() : null;
    if (wp && wp.partition) return wp.partition;
    return (wc && wc.session && wc.session.partition) || "";
  } catch (_) { return ""; }
}

function accountIdxOfWebContents(wc) {
  // Prefer the cicyAccountIdx tag stamped at creation (the only reliable source for
  // BrowserView tab guests, whose partition is never readable). Fall back to
  // partition parsing for surfaces that carry a real partition.
  if (wc && typeof wc.cicyAccountIdx === "number") return wc.cicyAccountIdx;
  const partition = partitionOfWebContents(wc);
  if (partition.startsWith("persist:sandbox-")) {
    const n = parseInt(partition.slice("persist:sandbox-".length), 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// Single source of truth for the window.open policy. App/internal popups
// (about:blank or trusted/local hosts — e.g. a popped-out ttyd terminal from CiCy
// Code) open in-place as REAL Electron windows WITH webviewTag (any <webview>
// inside them — terminal / artifact guest — otherwise collapses to 0x0).
//
// Any OTHER (external) URL is routed DETERMINISTICALLY by the OPENER's profile,
// and never lands in profile 0: an opener in profile 0 (the privileged/shared
// session — team cookies + trusted-origin RPC surface) has the link FORCED into
// sandbox profile 1; an opener already in a sandbox profile N opens the link in
// its OWN profile N. This mirrors the tab-browser policy (profile 0 link →
// openTab(1); else same profile) — no dialog, no leak into profile 0.
function windowOpenDecision(url, { wc } = {}) {
  log.info(`[WindowOpen] Intercepted: ${url}`);
  if (!url || url === "about:blank" || isTrustedUrl(url)) {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        icon: require("./app-icon").appIconPath(),
        webPreferences: {
          webviewTag: true, // embedded <webview> (ttyd/artifact) must render
          // hole #4: trusted pages no longer get raw Node. Their electronRPC
          // bridge comes from webview-preload via contextBridge, so a trusted-origin
          // XSS can't `require('child_process')` to bypass the rpc:guarded gate.
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, "../backends/webview-preload.js"),
          webSecurity: false,
          enableClipboard: true,
        },
      },
    };
  }
  // External URL: profile 0 → forced sandbox profile 1; any sandbox profile N →
  // its own profile N. Never in-session for profile 0.
  const openerIdx = accountIdxOfWebContents(wc);
  const target = openerIdx === 0 ? 1 : openerIdx;
  try { createWindow({ url }, target, true); }
  catch (e) { log.warn(`[WindowOpen] open external in profile ${target} failed: ${e && e.message}`); }
  return { action: "deny" };
}

function setupWindowHandlers(win) {
  win.webContents.setWindowOpenHandler(({ url }) => windowOpenDecision(url, { wc: win.webContents }));
  if (!win.webContents.debugger.isAttached()) {
    win.webContents.debugger.attach("1.3");
  }

  // 初始化窗口监控（在 dom-ready 之前调用）
  initWindowMonitoring(win);

  // Non-homepage windows (team / backend windows) close DIRECTLY — a close
  // actually destroys the window, it does NOT hide it. Only the
  // homepage is a persistent window; everything created here is disposable and
  // re-openable from the homepage. (Previously these preventDefault()+hide()'d,
  // so "closed" windows lingered hidden forever.)
  const _registryId = win.id;
  win.on("close", () => {
    log.info(`[Window ${_registryId}] Close → destroy: ${win.getTitle()}`);
  });
  // Persistent window registry: a USER/agent close keeps the record (status
  // "closed", re-openable). A close during app QUIT leaves it "open" so it
  // auto-reopens next launch. No-op for unregistered windows (e.g. homepage).
  // "closed" fires for both win.close() and win.destroy().
  win.on("closed", () => {
    try {
      if (!app || !app.isQuitting) {
        require("./window-registry").markClosed(_registryId);
      }
    } catch (e) {
      log.error("[WindowRegistry] markClosed failed:", e.message);
    }
  });

  // 🔥 全局下载处理 - 自动保存到 ~/Downloads/electron/
  const ses = win.webContents.session;
  if (!ses._autoDownloadEnabled) {
    ses._autoDownloadEnabled = true;
    ses.on("will-download", (event, item, webContents) => {
      // File-explorer downloads (/api/fs/download) should let the user choose
      // where to save: leave savePath unset so Electron shows the native Save As
      // dialog. Everything else keeps the silent auto-save to ~/Downloads/electron.
      const dlUrl = (() => { try { return item.getURL() || ""; } catch { return ""; } })();
      if (dlUrl.includes("/api/fs/download")) {
        log.info(`[Download] save-as dialog for ${item.getFilename()}`);
        return;
      }
      // 如果没有设置 savePath，自动保存
      setTimeout(() => {
        if (!item.getSavePath()) {
          const filename = item.getFilename();
          const savePath = path.join(app.getPath("home"), "Downloads", "electron", filename);
          fs.mkdirSync(path.dirname(savePath), { recursive: true });
          item.setSavePath(savePath);
          log.info(`[Auto Download] ${filename} -> ${savePath}`);
        }
      }, 0);
    });
  }

  win.webContents.on("dom-ready", async () => {
    // (Removed: the 产物/artifact bridge injection. electronRPC for trusted pages
    // is provided by webview-preload.js via contextBridge; the artifact webview
    // remote-control feature was deleted — superseded by the electron tab + chrome
    // profile browsers.)
    try {
      // 1. 获取当前页面的根域名
      const currentURL = win.webContents.getURL();
      const url = new URL(currentURL);
      const hostname = url.hostname;
      const port = url.port;

      // 2. 确定域名标识
      let domain;
      if (hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        // localhost 或 IP 地址，使用 hostname:port 作为标识
        domain = port ? `${hostname}_${port}` : hostname;
      } else {
        // 提取根域名 (例如: web.telegram.org -> telegram.org)
        const parts = hostname.split(".");
        domain = parts.length > 2 ? parts.slice(-2).join(".") : hostname;
      }

      // 3. 检查域名注入脚本
      const injectDir = path.join(os.homedir(), "data", "electron", "extension", "inject");
      const injectFile = path.join(injectDir, `${domain}.js`);

      // 4. 确保目录存在
      if (!fs.existsSync(injectDir)) {
        fs.mkdirSync(injectDir, { recursive: true });
      }

      let domainCode = "";

      // 5. 如果文件不存在，使用默认脚本并创建文件
      if (!fs.existsSync(injectFile)) {
        const defaultInjectPath = path.join(__dirname, "..", "extension", "inject.js");
        domainCode = fs.readFileSync(defaultInjectPath, "utf-8");
        fs.writeFileSync(injectFile, domainCode, "utf-8");
        log.info(`[DomReady] Created inject script for ${domain}`);
      } else {
        domainCode = fs.readFileSync(injectFile, "utf-8");
      }

      // 6. 注入脚本
      await win.webContents.executeJavaScript(`
        (async () => {
          try {
            ${domainCode}
          } catch(e) {
            log.error('Domain inject error:', e);
          }
        })()
      `);
      log.info(`[DomReady] Injected script for ${domain}`);
    } catch (error) {
      log.error("[DomReady] Error:", error);
    }
  });
}

// Cache the trusted-origin set so we don't hit the registry on every window
// event. Invalidated whenever backends are added/removed (registry.add /
// registry.remove call refreshTrustedOrigins() — wired in registry.js).
let _trustedOriginsCache = null;
function loadTrustedOrigins() {
  // The trusted set = the user-managed allowlist in
  // ~/cicy-ai/db/trusted-origins.json (built-ins localhost/127.0.0.1 included by
  // the store). Backends / teams are NO LONGER auto-trusted: "add a server" must
  // never implicitly grant a remote origin the right to run commands locally.
  // Users (incl. self-hosted) add their own domain explicitly in settings.
  try {
    const store = require("../profiles/trusted-origins-store");
    return new Set(store.listAll());
  } catch (e) {
    return new Set(["localhost", "127.0.0.1"]);
  }
}
function trustedOrigins() {
  if (!_trustedOriginsCache) _trustedOriginsCache = loadTrustedOrigins();
  return _trustedOriginsCache;
}
function refreshTrustedOrigins() {
  _trustedOriginsCache = null;
}

function isTrustedUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    // Exact-hostname match against the user allowlist ONLY. No domain-suffix
    // wildcard — a public-upload host under a trusted suffix (e.g.
    // r2.deepfetch.de5.net, which can serve attacker HTML) must never count as a
    // trusted RPC origin.
    return trustedOrigins().has(u.hostname);
  } catch {
    return false;
  }
}

// accountIdx default = 1 (user profile space). Account 0 is reserved for the
// platform's own/system windows; callers that want the system slot pass 0
// explicitly (e.g. local-teams). Agents opening windows should use >0.
function createWindow(options = {}, accountIdx = 1, forceNew = false) {
  const { width = 1200, height = 800, url, webPreferences = {}, x, y } = options;
  console.log("[createWindow] url:", url, "isTrusted:", isTrustedUrl(url));

  // Check if oneWindow mode is enabled - execute before coordinate logic
  if (config.oneWindow && !forceNew) {
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length > 0) {
      const existingWin = allWindows[0];
      log.info(
        `[WindowUtils] Single window mode enabled. Reusing existing window ${existingWin.id}`
      );

      if (existingWin.isMinimized()) existingWin.restore();
      existingWin.focus();

      if (url) {
        const currentUrl = existingWin.webContents.getURL();
        if (currentUrl === url) {
          log.info(`[WindowUtils] Same URL detected, reloading page`);
          existingWin.webContents.reload();
        } else {
          existingWin.loadURL(url);
        }
      }
      return existingWin;
    }
  }

  // 尝试加载保存的窗口状态（基于URL）
  const savedState = url ? loadWindowState(accountIdx, url) : null;

  // 如果没有指定位置和大小，使用保存的状态或自动偏移
  let posX = x;
  let posY = y;
  let winWidth = width;
  let winHeight = height;

  // 只有在没有明确指定位置时才使用保存的状态
  if (x === undefined && y === undefined && savedState) {
    posX = savedState.x;
    posY = savedState.y;
    log.info(`[WindowState] Restored position for ${url}: ${posX},${posY}`);
  } else if (posX === undefined || posY === undefined) {
    const allWindows = BrowserWindow.getAllWindows();
    const offset = allWindows.length * 30; // 每个窗口偏移30px
    posX = posX !== undefined ? posX : offset;
    posY = posY !== undefined ? posY : offset;
  }

  // 只有在没有明确指定大小时才使用保存的状态
  if (width === 1200 && height === 800 && savedState) {
    winWidth = savedState.width;
    winHeight = savedState.height;
    log.info(`[WindowState] Restored size for ${url}: ${winWidth}x${winHeight}`);
  }

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: posX,
    y: posY,
    icon: require("./app-icon").appIconPath(), // npx/unpackaged → set our own icon
    // (Windows has no built .exe to embed it; default electron icon otherwise).
    // Native menu bar collapses by default on win/linux; press Alt to
    // peek. Same UX as the homepage window — keeps the chrome out of
    // the way for backend pages.
    autoHideMenuBar: true,
    webPreferences: {
      offscreen: false, // 确保不是离屏渲染
      // hole #4: trusted pages run with NO raw Node (was nodeIntegration:
      // isTrustedUrl). electronRPC + window.cicy come from webview-preload via
      // contextBridge, so a trusted-origin XSS can't `require('child_process')`
      // past the rpc:guarded gate.
      nodeIntegration: false,
      contextIsolation: true,
      // webview-preload exposes electronRPC + window.cicy for EVERY window
      // open_window creates (contextBridge under isolation). Without it the
      // agent-desktop/agent-electron skills' `desktop_event rpc_call` failed with
      // 'electronRPC not available'.
      preload: path.join(__dirname, "../backends/webview-preload.js"),
      partition: `persist:sandbox-${accountIdx}`,
      // 启用剪贴板权限
      enableClipboard: true,
      // 允许 webview 访问剪贴板
      webSecurity: false, // 在开发环境中可以考虑禁用，生产环境需要谨慎
      ...webPreferences,
      // webviewTag MUST stay on for embedded <webview> (ttyd terminal, artifact
      // guest) to render — a 0x0/blank <webview> is the classic symptom of it
      // being off. Forced LAST so a caller's webPreferences can never disable it.
      webviewTag: true,
    },
  });

  // Stamp the profile on the window + its webContents so any holder of just the wc
  // (context menu, accountIdxOfWebContents, thumbnails) resolves the REAL profile
  // deterministically — session.partition/getWebPreferences().partition are not
  // reliably readable back.
  try { win.cicyAccountIdx = accountIdx; win.webContents.cicyAccountIdx = accountIdx; } catch (e) {}

  // 监听窗口状态变化并自动保存（基于URL）
  watchWindowState(win, accountIdx);

  // ✅ 核心修正：获取当前窗口真正使用的那个 session
  const ses = win.webContents.session;

  // 设置代理：优先用该 profile 持久化的 proxy（account-N.json），否则回退全局 config.proxy。
  // 这样新开窗口会自动套用账号自己保存的代理，无需手动 set_account_proxy。
  let proxyRules = "";
  let proxySource = "";
  try {
    const profileStore = require("../profiles/profile-store");
    const persisted = profileStore.proxyRules(profileStore.getProfile("electron", accountIdx)?.proxy);
    if (persisted) {
      proxyRules = persisted;
      proxySource = "profile";
    }
  } catch (err) {
    log.error(`[Proxy] Account ${accountIdx} 读取持久化代理失败:`, err);
  }
  if (!proxyRules && config.proxy) {
    proxyRules = config.proxy;
    proxySource = "global";
  }
  // account 0 = 本地团队共享会话(连 localhost 的 cicy-code)→ **绝不走代理**(确认 + 实测白板根因):
  // 否则 gotty 终端 ws `ws://127.0.0.1:8008/ttyd/<pane>/ws` 被路由进 chrome 代理(mihomo:20001)→
  // ERR_CONNECTION_REFUSED → webtty slave closed → 终端白板。强制 direct,顺便清掉该持久会话上
  // 可能残留的旧代理(profile-store 之前给 account 0 存过)。
  if (accountIdx === 0) {
    ses
      .setProxy({ mode: "direct" })
      .then(() => log.info(`[Proxy] account 0(本地团队)强制直连,不走代理`))
      .catch((err) => log.error(`[Proxy] account 0 direct 失败:`, err));
  } else if (proxyRules) {
    // 用户 profile(N>=1)用代理,但 **localhost 一律 bypass** —— 在 profile 里开本地团队、或任何
    // 到本机 cicy-code 的连接都直连,不被代理拦。
    ses
      .setProxy({ proxyRules, proxyBypassRules: "127.0.0.1,localhost,[::1]" })
      .then(() => {
        log.info(`[Proxy] Account ${accountIdx} 已设置代理 (${proxySource}): ${proxyRules}(bypass localhost)`);
      })
      .catch((err) => {
        log.error(`[Proxy] Account ${accountIdx} 设置代理失败:`, err);
      });
  }
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    // 允许麦克风权限（语音输入需要）
    if (permission === "media") {
      log.info(`[Permission] 已自动允许: ${permission}`);
      return callback(true);
    }
    // 允许剪贴板权限
    if (permission.startsWith("clipboard")) {
      log.info(`[Permission] 已自动允许剪贴板权限: ${permission}`);
      return callback(true);
    }
    log.info(`[Permission] 已自动拒绝: ${permission}`);
    return callback(false);
  });

  // 💡 额外保险：处理权限检查（某些新版 Electron 需要这个）
  ses.setPermissionCheckHandler((webContents, permission, originatingOrigin) => {
    if (permission === "media") return true;
    // 允许剪贴板权限检查
    if (permission.startsWith("clipboard")) return true;
    return false;
  });

  function getTitlePrefix() {
    return `${win.id}`;
  }

  win.webContents.on("page-title-updated", (event, title) => {
    win.setTitle(`${getTitlePrefix()} | ${title}`);
  });

  setupWindowHandlers(win);

  // Persistent window registry: record this window (dedup by accountIdx+url),
  // then keep its url/title/bounds fresh so a restart can restore it. The
  // "closed" handler in setupWindowHandlers flips status when it's closed.
  try {
    const registry = require("./window-registry");
    registry.registerOpen({
      accountIdx,
      url: url || "",
      title: win.getTitle(),
      bounds: win.getBounds(),
      liveId: win.id,
    });
    let boundsTimer = null;
    const touchBounds = () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (!win.isDestroyed()) registry.touch({ liveId: win.id, bounds: win.getBounds() });
      }, 500);
    };
    win.on("resize", touchBounds);
    win.on("move", touchBounds);
    win.webContents.on("page-title-updated", () => {
      if (!win.isDestroyed())
        registry.touch({
          liveId: win.id,
          title: win.getTitle(),
          url: win.webContents.getURL(),
        });
    });
    win.webContents.on("did-navigate", () => {
      if (!win.isDestroyed())
        registry.touch({ liveId: win.id, url: win.webContents.getURL() });
    });
  } catch (e) {
    log.error("[WindowRegistry] register failed:", e.message);
  }

  if (url) {
    win.loadURL(url);
  }

  return win;
}

function getWindowInfo(win) {
  try {
    const wc = win.webContents;
    if (!wc || !wc.session) return null;
    const partition = partitionOfWebContents(wc);
    // persist:sandbox-N → account N (N>=1 are user profiles). Anything on the
    // default session (homepage / platform system windows, partition "") maps
    // to account 0 — the reserved system slot.
    const accountIdx = partition.startsWith("persist:sandbox-")
      ? parseInt(partition.replace("persist:sandbox-", ""), 10)
      : 0;

    const { workerId } = getWorkerIdentity();
    return {
      id: win.id,
      workerId,
      agentId: createAgentId(workerId, win.id),
      runtimeSessionId: createRuntimeSessionId(workerId, partition, accountIdx),
      windowRef: createWindowRef(workerId, win.id),
      title: win.getTitle(),
      url: wc.getURL(),
      accountIdx,
      partition,
      debuggerIsAttached: wc.debugger.isAttached(),
      isActive: win.isFocused(),
      bounds: win.getBounds(),
      isDomReady: !wc.isLoading(),
      isLoading: wc.isLoading(),
      isDestroyed: wc.isDestroyed(),
      isCrashed: wc.isCrashed(),
      isWaitingForResponse: wc.isWaitingForResponse(),
      isVisible: win.isVisible(),
      isMinimized: win.isMinimized(),
      isMaximized: win.isMaximized(),
    };
  } catch (e) {
    return null;
  }
}

if (app) {
  app.on("browser-window-created", (event, win) => {
    setupWindowHandlers(win);
  });

  // <webview> guests (Team Helper drawer, artifact, an embedded CiCy Code SPA)
  // get their OWN webContents — setupWindowHandlers only runs for BrowserWindows,
  // so a window.open from INSIDE a <webview> would otherwise create a window with
  // default webPreferences (webviewTag=false) → any nested <webview> there is 0x0.
  // Give every guest a handler that opens its popups WITH webviewTag.
  app.on("web-contents-created", (_e, contents) => {
    try {
      if (contents.getType && contents.getType() === "webview") {
        // NOTE: do NOT attach contextMenu here — the global contextMenu() in
        // main.js now also auto-attaches to <webview> guests, so an explicit
        // attach made them get TWO right-click menus (双重弹窗). Global covers it.
        contents.setWindowOpenHandler(({ url }) => {
          // External (cross-origin http/https) links opened from a <webview> guest
          // — e.g. the gotty terminal's "打开链接" confirm button — go to the user's
          // SYSTEM browser instead of a new in-app window. Same-origin popups (a
          // team app opening its own sub-page) keep the in-app window so embedded
          // app flows aren't disturbed. (master: gotty open link 用系统 browser 打开)
          try {
            if (/^https?:\/\//i.test(url)) {
              let guestOrigin = "";
              try { guestOrigin = new URL(contents.getURL()).origin; } catch (_e) {}
              if (new URL(url).origin !== guestOrigin) {
                shell.openExternal(url);
                return { action: "deny" };
              }
            }
          } catch (_e) {}
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              autoHideMenuBar: true,
              webPreferences: {
                webviewTag: true,
                // hole #4: no raw Node for trusted pages (see createWindow above).
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: false,
                enableClipboard: true,
              },
            },
          };
        });
      }
    } catch (e) {
      log.warn(`[web-contents-created] guest open-handler failed: ${e.message}`);
    }
  });
}

module.exports = {
  createWindow,
  setupWindowHandlers,
  windowOpenDecision,
  getWindowInfo,
  partitionOfWebContents,
  accountIdxOfWebContents,
  refreshTrustedOrigins,
  isTrustedUrl,
};
