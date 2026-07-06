// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const { z } = require("zod");
const { loadToolCatalog } = require("../server/tool-catalog");
const { zodToJsonSchema } = require("../server/tool-registry");

// A meta-tool: lets any electronRPC caller (renderer, <webview>, agent-desktop
// `rpc list_tools`) discover the full set of registered tools at runtime —
// previously the only index was HTTP /openapi.json, unreachable over the IPC /
// desktop_event bridge.
module.exports = (registerTool) => {
  registerTool(
    "list_tools",
    "列出本机 cicy-desktop 当前注册的所有 electronRPC 工具(name/description/tag;可选 inputSchema)。用于运行时发现可调用工具全集。",
    z.object({
      tag: z.string().optional().describe("只列某个 tag 下的工具,如 Chrome / System / General"),
      schema: z.boolean().optional().describe("为 true 时附带每个工具的 inputSchema(JSON Schema)"),
      names_only: z.boolean().optional().describe("为 true 时只返回工具名数组"),
    }),
    async ({ tag, schema, names_only } = {}) => {
      const cat = loadToolCatalog();
      let records = Array.from(cat.toolsByName.values());
      if (tag) records = records.filter((r) => (r.tag || "General") === tag);
      records.sort(
        (a, b) => (a.tag || "General").localeCompare(b.tag || "General") || a.name.localeCompare(b.name)
      );

      let payload;
      if (names_only) {
        payload = { count: records.length, tools: records.map((r) => r.name) };
      } else {
        payload = {
          count: records.length,
          tags: [...new Set(records.map((r) => r.tag || "General"))].sort(),
          tools: records.map((r) => {
            const t = { name: r.name, description: r.description, tag: r.tag || "General" };
            if (schema) {
              try { t.inputSchema = zodToJsonSchema(r.schema); } catch { t.inputSchema = null; }
            }
            return t;
          }),
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
    { tag: "System" }
  );
};
