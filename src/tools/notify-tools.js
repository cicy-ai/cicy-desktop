// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const { Notification, BrowserWindow, shell } = require("electron");
const { z } = require("zod");

// OS desktop notification (mac Notification Center / Windows toast / Linux
// libnotify). Main-process Electron Notification — no renderer/window needed,
// so it works even when every window is closed or minimized.
//
// Windows: toasts require an AppUserModelId, which main.js already sets
// ("com.cicy.desktop"). Packaged builds inherit it; dev runs show the toast
// attributed to Electron until packaged.
//
// Click behavior: focus the main CiCy Desktop window (default), then open
// `url` in the system browser if given. Deep-linking into an in-app tab is
// deliberately NOT done here — tab routing belongs to tab-browser tools.
function registerTools(registerTool) {
  registerTool(
    "notify",
    "发送操作系统桌面通知(mac 通知中心 / Windows toast)。点击通知默认聚焦 CiCy Desktop 主窗口;可选 url 在点击时用系统浏览器打开。",
    z.object({
      title: z.string().describe("通知标题(大字)"),
      body: z.string().optional().describe("通知正文(小字,放 prompt/消息摘要)"),
      subtitle: z.string().optional().describe("副标题(仅 macOS 显示)"),
      silent: z.boolean().optional().describe("true = 不播放提示音"),
      url: z.string().optional().describe("点击通知时用系统默认浏览器打开的 URL"),
      focus: z.boolean().optional().describe("点击通知时聚焦主窗口,默认 true"),
    }),
    async ({ title, body, subtitle, silent, url, focus }) => {
      if (!Notification.isSupported()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "notifications not supported on this platform" }) }],
          isError: true,
        };
      }
      const n = new Notification({ title, body: body || "", subtitle, silent: !!silent });
      n.on("click", () => {
        try {
          if (focus !== false) {
            const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
            if (win) {
              if (win.isMinimized()) win.restore();
              win.show();
              win.focus();
            }
          }
          if (url) shell.openExternal(url);
        } catch {}
      });
      n.show();
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, platform: process.platform, title }) }],
      };
    },
    { tag: "System" }
  );
}

module.exports = registerTools;
