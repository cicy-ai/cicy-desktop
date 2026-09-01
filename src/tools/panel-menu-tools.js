// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// panel-menu-tools — the "+ 面板" dropdown config as RPC TOOLS.
//
// panel-menu-store is already reachable from the bundled homepage through the
// `panelMenu:get/set` IPC channels (window.cicy.panelMenu). Those channels are
// useless to the WEB build of the same UI: a page served from
// desktop.cicy-ai.com and embedded via <webview> gets webview-preload, which
// exposes only `window.electronRPC` — and electronRPC dispatches registered
// TOOLS, not arbitrary ipcMain channels.
//
// Registering the same store as tools is what lets one UI work in both places:
//   • bundled snapshot → window.cicy.panelMenu.get()/set()   (IPC, unchanged)
//   • web build in a webview → window.electronRPC("get_panel_menu")
// …and, as a free side effect, from agent-desktop / hub-desktop, so the menu of
// a whole fleet can be inspected or aligned remotely.
//
// The store stays authoritative for validation: it only ever accepts built-in
// ids (every preset must have a real page behind it), so a bad payload from any
// caller degrades to "ignored entry", never to a menu that opens blank.
const { z } = require("zod");

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function err(msg) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(msg) }, null, 2) }],
    isError: true,
  };
}

function registerTools(registerTool) {
  registerTool(
    "get_panel_menu",
    '读取"+ 面板"下拉菜单的可配置项:返回全部内置面板及其当前显示名与开关状态(顺序即菜单顺序)。供 web 版设置界面渲染完整列表。',
    z.object({}),
    async () => {
      try {
        const store = require("../tabbrowser/panel-menu-store");
        return ok({ ok: true, items: store.list(), builtin: store.BUILTIN, path: store.STORE });
      } catch (e) {
        return err(e && e.message);
      }
    },
    { tag: "System" }
  );

  registerTool(
    "set_panel_menu",
    '保存"+ 面板"菜单配置(排序/改名/启用停用),返回合并校验后的结果。items 顺序即菜单顺序;只接受内置 id,未知 id 会被忽略。',
    z.object({
      items: z
        .array(
          z.object({
            id: z
              .string()
              .describe(
                "内置面板 id，如 blank / telegram-matrix / redroid-matrix / facebook-matrix"
              ),
            title: z.string().optional().describe("显示名，留空用内置默认名"),
            enabled: z.boolean().optional().describe("是否在菜单中显示，默认 true"),
          })
        )
        .describe("菜单项，数组顺序即显示顺序"),
    }),
    async (args) => {
      try {
        const store = require("../tabbrowser/panel-menu-store");
        return ok({ ok: true, items: store.save(args.items || []) });
      } catch (e) {
        return err(e && e.message);
      }
    },
    { tag: "System" }
  );
}

module.exports = registerTools;
