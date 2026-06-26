// Shared electron-context-menu (ecm) config + a universal attach helper so the
// SAME i18n'd right-click menu — 重新加载 / 复制 / 粘贴 / 检查元素(DevTools)— applies to
// EVERY surface: the tab-browser SHELL window (host/"BaseWindow"), BrowserView
// tabs, <webview> guests, popups, the homepage window. ecm only auto-attaches to
// a BrowserWindow's MAIN webContents, so the shell window and guests otherwise
// fall back to the OS-native menu; attachContextMenu() (wired on app
// 'web-contents-created' in main.js) closes that gap, guarded so nothing
// double-pops.
const { default: contextMenu } = require("electron-context-menu");
const { t } = require("../i18n"); // 右键菜单走 i18n(主进程同一份 locale)

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
  // prepend 是函数,每次弹出时调用 → t() 拿到的是当前 locale(动态)。
  prepend: (_defaultActions, _params, win) => {
    const wc = wcOf(win);
    const wcId = wc && wc.id != null ? wc.id : "?";
    // 给 agent 用的一句话指令:带上当前 webContents id,让它用 agent-electron 操作这个 webview。
    const skillPrompt = t("ctxMenu.skillPrompt", { id: wcId });
    return [
      { label: t("ctxMenu.webviewId", { id: wcId }), enabled: false },
      { label: t("ctxMenu.copySkillCmd"), click: () => { try { require("electron").clipboard.writeText(skillPrompt); } catch (e) {} } },
      { type: "separator" },
      { label: t("ctxMenu.reload"), click: () => { try { if (wc) wc.reload(); } catch (e) {} } },
      { type: "separator" },
    ];
  },
};

// labels 用 getter:ecm 按 menuItem.id 取 options.labels[id],所以 KEY 必须 = ecm 的
// item id(inspect 不是 inspectElement!saveImageAs/saveVideoAs 也得各自给)。getter 让
// 每次 spread({...OPTIONS}) 都按当前 locale 现取,locale 切换也跟得上。
Object.defineProperty(OPTIONS, "labels", {
  enumerable: true,
  get() {
    return {
      cut: t("ctxMenu.cut"),
      copy: t("ctxMenu.copy"),
      paste: t("ctxMenu.paste"),
      selectAll: t("ctxMenu.selectAll"),
      inspect: t("ctxMenu.inspect"),                 // FIX: ecm 的 id 是 inspect,不是 inspectElement
      services: t("ctxMenu.services"),
      lookUpSelection: t("ctxMenu.lookUpSelection"),
      searchWithGoogle: t("ctxMenu.searchWithGoogle"),
      copyImage: t("ctxMenu.copyImage"),
      copyImageAddress: t("ctxMenu.copyImageAddress"),
      saveImage: t("ctxMenu.saveImage"),
      saveImageAs: t("ctxMenu.saveImageAs"),         // 之前缺 → 显示英文
      copyVideoAddress: t("ctxMenu.copyVideoAddress"),
      saveVideo: t("ctxMenu.saveVideo"),
      saveVideoAs: t("ctxMenu.saveVideoAs"),         // 之前缺 → 显示英文
      copyLink: t("ctxMenu.copyLink"),
      saveLinkAs: t("ctxMenu.saveLinkAs"),
    };
  },
});

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
