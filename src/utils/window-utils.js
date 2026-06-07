const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
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

function setupWindowHandlers(win) {
  // Hook window.open to use createWindow with proper webPreferences (webviewTag etc)
  win.webContents.setWindowOpenHandler(({ url }) => {
    log.info(`[WindowOpen] Intercepted: ${url}`);
    if (url && url !== "about:blank") {
      showOpenLinkDialog(win, url);
    }
    return { action: "deny" };
  });
  if (!win.webContents.debugger.isAttached()) {
    win.webContents.debugger.attach("1.3");
  }

  // 初始化窗口监控（在 dom-ready 之前调用）
  initWindowMonitoring(win);

  // 🔥 确保窗口可以正常关闭 + 添加日志
  // Close → hide. The user can re-open from the tray icon or topbar menu.
  // Only actually destroy the window when the app is quitting (set by the
  // tray "Quit" item / "before-quit" handler in main.js).
  win.on("close", (event) => {
    log.info(`[Window ${win.id}] Close event triggered: ${win.getTitle()}`);
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  // 🔥 全局下载处理 - 自动保存到 ~/Downloads/electron/
  const ses = win.webContents.session;
  if (!ses._autoDownloadEnabled) {
    ses._autoDownloadEnabled = true;
    ses.on("will-download", (event, item, webContents) => {
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
    // Auto-inject electronRPC for trusted URLs. Trust comes from
    // isTrustedUrl(), which includes built-in dev hosts AND any backend the
    // user explicitly added to the registry (they opt in by adding the URL,
    // and the auth token is required to reach the cicy-code there anyway).
    const pageUrl = win.webContents.getURL();
    try {
      if (isTrustedUrl(pageUrl)) {
        const rpcCode = `
          if (!window.electronRPC) {
            try {
              const { ipcRenderer } = require('electron');
              window.electronRPC = (tool, args) => ipcRenderer.invoke('rpc', tool, args || {});
              console.log('[RPC] electronRPC ready');
            } catch(e) {}
          }
          // window.cicy.artifact — remote control of the 产物 (artifact) <webview>
          // guest webContents for cicy-code's artifactBridge.ts. Targets the
          // element id 'cicy-artifact-webview'; round-trips to artifact-ipc.js.
          (function(){
            try {
              if (window.cicy && window.cicy.artifact) return;
              const { ipcRenderer } = require('electron');
              window.cicy = window.cicy || {};
              const guestId = () => {
                const el = document.getElementById('cicy-artifact-webview');
                if (!el || typeof el.getWebContentsId !== 'function')
                  throw new Error('artifact webview not mounted (open the 产物 tab once)');
                return el.getWebContentsId();
              };
              let _attached = false;
              window.cicy.artifact = {
                invoke: (method, args) =>
                  ipcRenderer.invoke('artifact:invoke', { guestId: guestId(), method, args: args || [] }),
                cdp: {
                  attach: (protocolVersion) =>
                    ipcRenderer.invoke('artifact:cdp-attach', { guestId: guestId(), protocolVersion })
                      .then((r) => { _attached = true; return r; }),
                  detach: () =>
                    ipcRenderer.invoke('artifact:cdp-detach', { guestId: guestId() })
                      .then((r) => { _attached = false; return r; }),
                  isAttached: () => _attached,
                  send: (method, params) =>
                    ipcRenderer.invoke('artifact:cdp-send', { guestId: guestId(), method, params: params || {} }),
                },
              };
              try { ipcRenderer.removeAllListeners('artifact:event'); } catch(e) {}
              ipcRenderer.on('artifact:event', (_e, detail) => {
                if (detail && detail.source === 'cdp' && detail.method === '__detached') _attached = false;
                try { window.dispatchEvent(new CustomEvent('cicy-artifact-event', { detail: detail })); } catch(e) {}
              });
              console.log('[artifact] window.cicy.artifact ready');
            } catch(e) { console.error('[artifact] bridge inject failed', e && e.message); }
          })();
        `;
        if (win.webContents.debugger.isAttached()) {
          await win.webContents.debugger.sendCommand("Runtime.evaluate", { expression: rpcCode });
        } else {
          await win.webContents.executeJavaScript(rpcCode);
        }
      }
    } catch (e) {
      log.error("[RPC inject]", e.message);
    }

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
  // Built-in always-trusted hosts (dev + reserved internal domain).
  const set = new Set(["localhost", "127.0.0.1"]);
  try {
    // Lazy require to avoid a cycle (registry.js requires electron.app which
    // isn't ready when this module is first loaded by main.js).
    const registry = require("../backends/registry");
    for (const b of registry.list()) {
      if (!b || !b.url) continue;
      try {
        const h = new URL(b.url).hostname;
        if (h) set.add(h);
      } catch {}
    }
  } catch (e) {
    // Registry not ready yet — fall back to built-ins.
  }
  return set;
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
    if (u.hostname.endsWith(".de5.net")) return true;
    return trustedOrigins().has(u.hostname);
  } catch {
    return false;
  }
}

function createWindow(options = {}, accountIdx = 0, forceNew = false) {
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
    // Native menu bar collapses by default on win/linux; press Alt to
    // peek. Same UX as the homepage window — keeps the chrome out of
    // the way for backend pages.
    autoHideMenuBar: true,
    webPreferences: {
      webviewTag: true,
      offscreen: false, // 确保不是离屏渲染
      nodeIntegration: isTrustedUrl(url),
      contextIsolation: !isTrustedUrl(url),
      // electronRPC + window.cicy for EVERY window open_window creates — without
      // this, untrusted (contextIsolation:true) pages had no electronRPC and the
      // agent-desktop/agent-electron skills' `desktop_event rpc_call` failed with
      // 'electronRPC not available'. webview-preload self-adapts to the isolation
      // mode (contextBridge when isolated, direct window assign when not).
      preload: path.join(__dirname, "../backends/webview-preload.js"),
      partition: `persist:sandbox-${accountIdx}`,
      // 启用剪贴板权限
      enableClipboard: true,
      // 允许 webview 访问剪贴板
      webSecurity: false, // 在开发环境中可以考虑禁用，生产环境需要谨慎
      ...webPreferences,
    },
  });

  // 监听窗口状态变化并自动保存（基于URL）
  watchWindowState(win, accountIdx);

  // ✅ 核心修正：获取当前窗口真正使用的那个 session
  const ses = win.webContents.session;

  // 设置代理（如果全局配置了）
  if (config.proxy) {
    const proxyConfig = {
      proxyRules: config.proxy,
      // proxyBypassRules removed
    };
    ses
      .setProxy(proxyConfig)
      .then(() => {
        log.info(`[Proxy] Account ${accountIdx} 已设置代理: ${config.proxy}`);
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

  if (url) {
    win.loadURL(url);
  }

  return win;
}

function getWindowInfo(win) {
  try {
    const wc = win.webContents;
    if (!wc || !wc.session) return null;
    const partition = wc.session.partition || "";
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
}

function showOpenLinkDialog(parentWin, url) {
  const i18n = require("../i18n");
  dialog
    .showMessageBox(parentWin, {
      type: "question",
      buttons: [
        i18n.t("dialog.openLink.openInBrowser"),
        i18n.t("dialog.openLink.openInApp"),
        i18n.t("dialog.openLink.cancel"),
      ],
      defaultId: 0,
      title: i18n.t("dialog.openLink.title"),
      message: i18n.t("dialog.openLink.message"),
      detail: url,
    })
    .then(({ response }) => {
      if (response === 0) {
        shell.openExternal(url);
      } else if (response === 1) {
        createWindow({ url }, 0, true);
      }
    });
}

module.exports = {
  createWindow,
  setupWindowHandlers,
  getWindowInfo,
  refreshTrustedOrigins,
};
