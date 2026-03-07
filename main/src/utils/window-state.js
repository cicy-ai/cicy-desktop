const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const STATE_DIR = path.join(os.homedir(), "data", "electron", "state");

// 确保状态目录存在
function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

// 生成URL的hash作为唯一标识
function getUrlHash(url) {
  if (!url) return "default";
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace(/^www\./, "");
    return crypto.createHash("md5").update(domain).digest("hex").substring(0, 8);
  } catch {
    return "default";
  }
}

// 获取状态文件路径
function getStatePath(accountIdx, urlHash) {
  return path.join(STATE_DIR, `${accountIdx}-${urlHash}.json`);
}

// 加载窗口状态
function loadWindowState(accountIdx, url) {
  try {
    const urlHash = getUrlHash(url);
    const statePath = getStatePath(accountIdx, urlHash);
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      console.log(`[WindowState] Loaded state for ${accountIdx}-${urlHash} (${url})`);
      return state;
    }
  } catch (error) {
    console.error(`[WindowState] Failed to load state:`, error);
  }
  return null;
}

// 保存窗口状态
function saveWindowState(accountIdx, url, state) {
  try {
    ensureStateDir();
    const urlHash = getUrlHash(url);
    const statePath = getStatePath(accountIdx, urlHash);
    const stateWithUrl = { ...state, url, domain: new URL(url).hostname };
    fs.writeFileSync(statePath, JSON.stringify(stateWithUrl, null, 2), "utf8");
    console.log(`[WindowState] Saved state for ${accountIdx}-${urlHash}`);
  } catch (error) {
    console.error(`[WindowState] Failed to save state:`, error);
  }
}

// 删除窗口状态
function removeWindowState(accountIdx, url) {
  try {
    const urlHash = getUrlHash(url);
    const statePath = getStatePath(accountIdx, urlHash);
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
      console.log(`[WindowState] Removed state for ${accountIdx}-${urlHash}`);
    }
  } catch (error) {
    console.error(`[WindowState] Failed to remove state:`, error);
  }
}

// 监听窗口状态变化
function watchWindowState(win, accountIdx) {
  let saveTimeout = null;
  let currentUrl = win.webContents.getURL();

  const saveState = () => {
    if (win.isDestroyed()) return;

    const url = win.webContents.getURL();
    if (!url || url === "about:blank") return;

    const bounds = win.getBounds();
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
      updatedAt: new Date().toISOString(),
    };

    saveWindowState(accountIdx, url, state);
    currentUrl = url;
  };

  // 防抖保存
  const debouncedSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveState, 500);
  };

  // 监听窗口事件
  win.on("resize", debouncedSave);
  win.on("move", debouncedSave);
  win.on("maximize", saveState);
  win.on("unmaximize", saveState);
  win.on("enter-full-screen", saveState);
  win.on("leave-full-screen", saveState);

  // URL变化时保存
  win.webContents.on("did-navigate", () => {
    const newUrl = win.webContents.getURL();
    if (newUrl !== currentUrl) {
      saveState();
    }
  });

  // 窗口关闭时保存最终状态（不删除）
  win.on("closed", () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveState();
  });
}

module.exports = {
  loadWindowState,
  saveWindowState,
  removeWindowState,
  watchWindowState,
};
