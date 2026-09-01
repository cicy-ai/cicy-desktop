// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// hub-team-tools — the remote-drivable API behind "从 ws-hub 总控台控制每一台
// cicy-desktop 打开哪个 team 用 profile 0".
//
// The operator's hub control surface issues this over the desktop_event rpc_call
// bridge; it runs ON the target node and opens the chosen team/project as a TAB
// in that node's profile-0 tab-browser window (the same place the homepage and
// other teams live). All the owner's teams share one origin
// (https://<tenant>.hub.cicy-ai.com); a project is a hash route under it, so
// "which team" is just which project.
//
// Two addressing modes:
//   • { project }         → open the owner hub origin at #/project/<project>
//                           (or { url } for an exact owner-hub URL). Needs the
//                           node to be hub-logged-in so the owner host is known.
//   • { instanceId }      → mint a fresh one-time hub grant for that instance and
//                           open the granted URL (cross-instance open; also what
//                           refreshes owner trust via grantUrl()).
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
    "hub_open_team",
    "在 profile 0 打开指定的 hub team/project 标签（ws-hub 总控台远程控制每台桌面打开哪个团队）。project=项目 hash 路由；instanceId=为其他实例签发一次性 grant 后打开；url=精确的 owner hub 地址。",
    z.object({
      project: z.string().optional().describe("项目标识，打开 owner hub 的 #/project/<project>"),
      instanceId: z
        .string()
        .optional()
        .describe("要打开的实例 id：经 hub grant 一次性授权后打开其地址"),
      url: z.string().optional().describe("精确 URL（必须在 owner hub origin 下）"),
      port: z.number().optional().describe("instanceId 模式下要打开的本地端口，默认 0"),
      activate: z.boolean().optional().describe("是否切到该标签，默认 true"),
      title: z.string().optional().describe("标签标题"),
    }),
    async (args) => {
      const hub = require("../backends/hub-client");
      const hubTrust = require("../utils/hub-trust");
      const tb = require("./tab-browser-tools");
      const activate = args.activate !== false;

      // Mode B: cross-instance open via a fresh grant (also (re)records owner trust).
      if (args.instanceId) {
        let g;
        try {
          g = await hub.grantUrl({ id: args.instanceId, port: Number(args.port) || 0, next: "/" });
        } catch (e) {
          return err(`grant 失败: ${(e && e.message) || e}`);
        }
        const r = await tb.openTab(0, g.url, {
          systemOpen: true,
          trusted: false,
          team: true,
          title: args.title || g.host,
          colorKey: args.instanceId,
          activate,
        });
        return ok({
          ok: true,
          mode: "instance",
          host: "https://" + g.host,
          winId: r.winId,
          tabId: r.tabId,
        });
      }

      // Mode A: open the owner's own hub origin (optionally at a project).
      const own = hubTrust.ownerHubHost();
      if (!own) return err("尚未确定 owner hub（此桌面未登录 hub，或还没打开过任何 team）");
      let target;
      if (args.url) {
        if (!hubTrust.isOwnerHubOrigin(args.url)) return err("url 不在 owner hub origin 下，拒绝");
        target = args.url;
      } else {
        const base = `https://${own}/`;
        target = args.project ? `${base}#/project/${encodeURIComponent(args.project)}` : base;
      }
      // trusted:true → the tab gets the electronRPC bridge (it's the operator's own
      // control origin), so the opened team can itself drive this desktop.
      const r = await tb.openTab(0, target, {
        systemOpen: true,
        trusted: true,
        team: true,
        title: args.title || "",
        colorKey: args.project ? `project:${args.project}` : own,
        activate,
      });
      return ok({ ok: true, mode: "project", url: target, winId: r.winId, tabId: r.tabId });
    },
    { tag: "System" }
  );
}

module.exports = registerTools;
