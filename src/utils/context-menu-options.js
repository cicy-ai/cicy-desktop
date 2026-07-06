// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

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

// 在被右键的 webContents 里弹一个自包含的浮层 toast(覆盖 homepage / tab / <webview>
// 所有 surface —— 渲染层的 toast 系统只在 homepage,够不到 webview)。纯 .style 设置,
// CSP 友好;1.6s 后淡出移除。best-effort,失败不影响复制本身。
function injectToast(wc, msg) {
  try {
    if (!wc || !wc.executeJavaScript) return;
    const js = `(function(){try{
      var d=document.createElement('div');d.textContent=${JSON.stringify(String(msg || ""))};
      var s=d.style;s.position='fixed';s.left='50%';s.bottom='32px';s.transform='translateX(-50%)';
      s.zIndex='2147483647';s.background='rgba(20,22,28,.96)';s.color='#e6edf3';s.padding='10px 16px';
      s.borderRadius='10px';s.fontSize='13px';s.fontFamily='-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
      s.boxShadow='0 8px 30px rgba(0,0,0,.5)';s.opacity='0';s.transition='opacity .18s';s.pointerEvents='none';
      document.body.appendChild(d);requestAnimationFrame(function(){d.style.opacity='1';});
      setTimeout(function(){d.style.opacity='0';setTimeout(function(){try{d.remove();}catch(e){}},240);},1600);
    }catch(e){}})();`;
    wc.executeJavaScript(js, true).catch(() => {});
  } catch (e) {}
}

const OPTIONS = {
  showLookUpSelection: true,
  showSearchWithGoogle: false, // 「用 Google 搜索」点了无效(沙箱里打不开外部搜索)→ 移除
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
    const url = (() => { try { return wc && wc.getURL ? wc.getURL() : ""; } catch (e) { return ""; } })();
    const title = (() => { try { return wc && wc.getTitle ? wc.getTitle() : ""; } catch (e) { return ""; } })();
    // profile id = 它所在 session 的 accountIdx:partition `persist:sandbox-<N>` → N,否则 0(系统槽)。
    // profile id = the webContents' account. Tab-browser BrowserView guests do NOT
    // expose a readable partition (session.partition AND getWebPreferences().partition
    // both come back empty → everything mis-reported as profile 0), so read the
    // `cicyAccountIdx` tag stamped on the wc at tab creation. Fall back to partition
    // parsing only for non-tab surfaces (BrowserWindow / <webview>) without the tag.
    const profile = (() => {
      try {
        if (wc && typeof wc.cicyAccountIdx === "number") return wc.cicyAccountIdx;
        const wp = wc && wc.getWebPreferences ? wc.getWebPreferences() : null;
        const part = (wp && wp.partition) || (wc && wc.session && wc.session.partition) || "";
        const m = /^persist:sandbox-(\d+)$/.exec(part);
        return m ? parseInt(m[1], 10) : 0;
      } catch (e) { return 0; }
    })();
    // 给 agent 用的一句话指令:带 webContents id + profile id + url + title,让它用 agent-electron 操作。
    const skillPrompt = t("ctxMenu.skillPrompt", { id: wcId, profile, url, title });
    // 导航:优先用 Electron 新 navigationHistory API,旧版兜底 wc.canGoBack/goBack。
    const nav = (wc && wc.navigationHistory) || null;
    const canBack = (() => { try { return nav ? nav.canGoBack() : (wc && wc.canGoBack && wc.canGoBack()); } catch (e) { return false; } })();
    const canFwd = (() => { try { return nav ? nav.canGoForward() : (wc && wc.canGoForward && wc.canGoForward()); } catch (e) { return false; } })();
    const goBack = () => { try { nav ? nav.goBack() : (wc && wc.goBack && wc.goBack()); } catch (e) {} };
    const goForward = () => { try { nav ? nav.goForward() : (wc && wc.goForward && wc.goForward()); } catch (e) {} };
    return [
      { label: t("ctxMenu.webviewId", { id: wcId }), enabled: false },
      { label: t("ctxMenu.copySkillCmd"), click: () => {
        try { require("electron").clipboard.writeText(skillPrompt); } catch (e) {}
        injectToast(wc, t("ctxMenu.copied"));
      } },
      { type: "separator" },
      { label: t("ctxMenu.goBack"), enabled: !!canBack, click: goBack },
      { label: t("ctxMenu.goForward"), enabled: !!canFwd, click: goForward },
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
