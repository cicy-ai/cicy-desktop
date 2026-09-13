// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0
//
// 域名注入(domain-inject):按 webContents 当前页面的根域名，读取
// ~/cicy-ai/electron/extension/inject/<域名>.js 并在该页面里执行。
//
// 历史上这段逻辑只写在 window-utils.js 里、只挂在 BrowserWindow 的主 webContents 上，
// 所以 tab-browser 的 BrowserView tab、以及 tab 里嵌套的 <webview> guest 都拿不到注入
// （它们是各自独立的 webContents）。这里抽成公用函数，让窗口、tab、webview 用同一套逻辑。

const path = require("path");
const fs = require("fs");
const os = require("os");
const log = require("electron-log");

// 由 hostname 推出注入文件名用的“域名标识”，与 window-utils 原逻辑保持一致：
//   web.telegram.org -> telegram.org（取后两段）
//   localhost / 纯 IP -> hostname[_port]
function domainOf(hostname, port) {
  if (hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return port ? `${hostname}_${port}` : hostname;
  }
  const parts = hostname.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
}

// 对给定 webContents 执行一次域名注入。dom-ready 时调用。
// createDefault=true 时若 <域名>.js 不存在，会用 extension/inject.js 的默认脚本创建它
// （沿用 window-utils 的既有行为）；webview 全局钩子传 true 以保持一致。
async function applyDomainInject(wc, { createDefault = true } = {}) {
  try {
    if (!wc || wc.isDestroyed()) return;
    const currentURL = wc.getURL();
    if (!currentURL || currentURL.startsWith("about:")) return; // 空白/内部页不注入
    let url;
    try { url = new URL(currentURL); } catch (e) { return; }
    // 只处理 http/https 页面；file:// / chrome:// / devtools:// 等一律跳过
    if (url.protocol !== "http:" && url.protocol !== "https:") return;

    const domain = domainOf(url.hostname, url.port);
    const injectDir = path.join(os.homedir(), "cicy-ai", "electron", "extension", "inject");
    const injectFile = path.join(injectDir, `${domain}.js`);

    if (!fs.existsSync(injectDir)) fs.mkdirSync(injectDir, { recursive: true });

    let domainCode = "";
    if (!fs.existsSync(injectFile)) {
      if (!createDefault) return; // 不存在且不建默认：无事可注入
      const defaultInjectPath = path.join(__dirname, "..", "extension", "inject.js");
      domainCode = fs.readFileSync(defaultInjectPath, "utf-8");
      fs.writeFileSync(injectFile, domainCode, "utf-8");
      log.info(`[DomainInject] Created inject script for ${domain}`);
    } else {
      domainCode = fs.readFileSync(injectFile, "utf-8");
    }
    if (!domainCode.trim()) return;

    // 注入到页面上下文。catch 用页面里一定有的 console.error（原实现误用了页面里不存在的
    // log.error，会在出错时再抛一次 ReferenceError）。
    await wc.executeJavaScript(`
      (async () => {
        try {
          ${domainCode}
        } catch (e) {
          console.error('Domain inject error:', e);
        }
      })()
    `);
    log.info(`[DomainInject] Injected script for ${domain} (wc ${wc.id}, type ${wc.getType && wc.getType()})`);
  } catch (error) {
    log.error("[DomainInject] Error:", error);
  }
}

module.exports = { applyDomainInject, domainOf };
