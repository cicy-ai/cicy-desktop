const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { config } = require("../config");
const { initWindowMonitoring } = require("./window-monitor");
const { loadWindowState, watchWindowState } = require("./window-state");

app.name = "ElectronMCP";

function setupWindowHandlers(win) {
  if (!win.webContents.debugger.isAttached()) {
    win.webContents.debugger.attach("1.3");
  }

  // 初始化窗口监控（在 dom-ready 之前调用）
  initWindowMonitoring(win);

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
          console.log(`[Auto Download] ${filename} -> ${savePath}`);
        }
      }, 0);
    });
  }

  win.webContents.on("dom-ready", async () => {
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
        console.log(`[DomReady] Created inject script for ${domain}`);
      } else {
        domainCode = fs.readFileSync(injectFile, "utf-8");
      }

      // 6. 注入脚本
      await win.webContents.executeJavaScript(`
        (async () => {
          try {
            ${domainCode}
          } catch(e) {
            console.error('Domain inject error:', e);
          }
        })()
      `);
      console.log(`[DomReady] Injected script for ${domain}`);
    } catch (error) {
      console.error("[DomReady] Error:", error);
    }
  });
}

function createWindow(options = {}, accountIdx = 0, forceNew = false) {
  const { width = 1200, height = 800, url, webPreferences = {}, x, y } = options;

  // Check if oneWindow mode is enabled - execute before coordinate logic
  if (config.oneWindow && !forceNew) {
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length > 0) {
      const existingWin = allWindows[0];
      console.log(
        `[WindowUtils] Single window mode enabled. Reusing existing window ${existingWin.id}`
      );

      if (existingWin.isMinimized()) existingWin.restore();
      existingWin.focus();

      if (url) {
        const currentUrl = existingWin.webContents.getURL();
        if (currentUrl === url) {
          console.log(`[WindowUtils] Same URL detected, reloading page`);
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
    console.log(`[WindowState] Restored position for ${url}: ${posX},${posY}`);
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
    console.log(`[WindowState] Restored size for ${url}: ${winWidth}x${winHeight}`);
  }

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: posX,
    y: posY,
    webPreferences: {
      offscreen: false, // 确保不是离屏渲染
      nodeIntegration: false,
      contextIsolation: true,
      partition: `persist:sandbox-${accountIdx}`,
      ...webPreferences,
    },
  });

  // 监听窗口状态变化并自动保存（基于URL）
  watchWindowState(win, accountIdx);

  // ✅ 核心修正：获取当前窗口真正使用的那个 session
  const ses = win.webContents.session;

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    // 允许麦克风权限（语音输入需要）
    if (permission === "media") {
      console.log(`[Permission] 已自动允许: ${permission}`);
      return callback(true);
    }
    console.log(`[Permission] 已自动拒绝: ${permission}`);
    return callback(false);
  });

  // 💡 额外保险：处理权限检查（某些新版 Electron 需要这个）
  ses.setPermissionCheckHandler((webContents, permission, originatingOrigin) => {
    if (permission === "media") return true;
    return false;
  });

  function getTitlePrefix() {
    return `${config.port}:${accountIdx}-${win.id} | `;
  }

  const titlePrefix = getTitlePrefix();

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

    return {
      id: win.id,
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

app.on("browser-window-created", (event, win) => {
  setupWindowHandlers(win);
});

module.exports = {
  createWindow,
  setupWindowHandlers,
  getWindowInfo,
};
