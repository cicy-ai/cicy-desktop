// Shared electron-context-menu (ecm) config + a universal attach helper so the
// SAME i18n'd right-click menu — 重新加载 / 复制 / 粘贴 / 检查元素(DevTools)— applies to
// EVERY surface: the tab-browser SHELL window (host/"BaseWindow"), BrowserView
// tabs, <webview> guests, popups, the homepage window. ecm only auto-attaches to
// a BrowserWindow's MAIN webContents, so the shell window and guests otherwise
// fall back to the OS-native menu; attachContextMenu() (wired on app
// 'web-contents-created' in main.js) closes that gap, guarded so nothing
// double-pops.
const { default: contextMenu } = require("electron-context-menu");

// ecm hands prepend/append the same `win` it was attached with — a BrowserWindow
// in auto-attach mode, or the raw webContents when we pass `{ window: wc }`.
// Resolve to the webContents either way.
function wcOf(win) {
  try { return win && win.webContents ? win.webContents : win; } catch (e) { return win; }
}

const OPTIONS = {
  showLookUpSelection: true,
  showSearchWithGoogle: true,
  showCopyImage: true,
  showCopyImageAddress: true,
  showSaveImageAs: true,
  showCopyVideoAddress: true,
  showSaveVideoAs: true,
  showCopyLink: true,
  showSaveLinkAs: true,
  // 检查元素 → webContents.inspectElement(x, y): opens DevTools focused on the
  // node under the cursor. Works on host windows AND <webview> guests.
  showInspectElement: true,
  showServices: true,
  // ecm has no built-in Reload item — add ONLY 重新加载 at the top. NO 切换开发者工具
  // anywhere (removed per master). <webview> guests keep their own custom menu —
  // see attachContextMenu.
  prepend: (_defaultActions, _params, win) => {
    const wc = wcOf(win);
    return [
      { label: "重新加载", click: () => { try { if (wc) wc.reload(); } catch (e) {} } },
      { type: "separator" },
    ];
  },
  labels: {
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    inspectElement: "检查元素",
    services: "服务",
    lookUpSelection: "查找选中内容",
    searchWithGoogle: "用 Google 搜索",
    copyImage: "复制图片",
    copyImageAddress: "复制图片地址",
    saveImage: "保存图片",
    copyVideoAddress: "复制视频地址",
    saveVideo: "保存视频",
    copyLink: "复制链接",
    saveLinkAs: "链接另存为...",
  },
};

// Attach the menu to the host window, BrowserView tabs AND <webview> guests, so
// right-click → 复制/粘贴 works on EVERY surface. Webviews used to be excluded on
// the assumption they carry their own copy menu, but on Windows that left
// selections uncopyable: the app menu's Ctrl+C / role:"copy" doesn't reach the
// focused <webview> guest, and no own-menu filled the gap. Giving guests the ecm
// 复制/粘贴 menu fixes copy cross-platform. Idempotent via __cicyCtxMenu so the
// web-contents-created hook + the tab-browser's per-tab call never double-pop.
function attachContextMenu(wc) {
  try {
    if (!wc || (wc.isDestroyed && wc.isDestroyed())) return;
    if (wc.__cicyCtxMenu) return;
    const t = wc.getType && wc.getType();
    if (t !== "window" && t !== "browserView" && t !== "webview") return; // host + tabs + <webview>
    wc.__cicyCtxMenu = true;
    contextMenu({ ...OPTIONS, window: wc });
  } catch (e) {}
}

module.exports = OPTIONS;
// Non-enumerable so spreading the options object (`{ ...CTX_MENU_OPTS }`) doesn't
// leak a function into ecm's option set.
Object.defineProperty(module.exports, "attachContextMenu", { value: attachContextMenu, enumerable: false });
