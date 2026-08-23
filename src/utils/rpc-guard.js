// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// RPC capability gate (security hole #3 — "trusted source XSS ≠ RCE").
//
// The renderer electronRPC bridge can invoke ANY registered tool, including host
// code/file execution (exec_*, file_*). The homepage is first-party system UI and
// keeps the unguarded "rpc" channel. EVERY OTHER renderer surface (team-helper
// <webview>, trusted remote pages, dom-ready injected scripts) is wired to the
// "rpc:guarded" channel: a *dangerous* tool there requires an explicit, page-
// scoped user grant. So a trusted origin that gets XSS'd cannot silently run a
// command — the user sees a consent dialog naming the origin + operation. Normal
// (non-dangerous) tools pass straight through.
//
// NOTE: this gate is only *enforceable* for renderers that have NO direct Node
// access (contextIsolation:true, no nodeIntegration) — e.g. the team-helper
// webview and the sandboxed tab-browser trusted tabs. A renderer created with
// nodeIntegration:true (the legacy createWindow trusted path) can `require()`
// child_process directly and bypass any IPC gate; closing that requires dropping
// its nodeIntegration, tracked separately.
const { dialog, BrowserWindow } = require("electron");
const { audit } = require("./rpc-audit");

// Host code-exec + host filesystem tools = the RCE surface.
const DANGEROUS_TOOLS = new Set([
  "exec_shell", "exec_python", "exec_node",
  "exec_shell_file", "exec_python_file", "exec_node_file",
  "file_read", "file_write", "file_upload", "file_download",
  "electron_inject",
]);
function isDangerousTool(t) { return DANGEROUS_TOOLS.has(t); }

// webContents.id -> granted origin (page-scoped; cleared on cross-doc nav / destroy).
const _grants = new Map();

function originOf(wc) {
  try { return new URL(wc.getURL()).origin; } catch { return wc.getURL() || "(unknown)"; }
}

function previewArgs(tool, args) {
  try {
    if (/^exec_/.test(tool)) {
      const c = args && (args.command || args.code || args.script || args.cmd);
      if (c) return `命令: ${String(c).slice(0, 240)}`;
    }
    if (/^file_/.test(tool)) {
      const p = args && (args.path || args.filename || args.file);
      if (p) return `路径: ${String(p).slice(0, 240)}`;
    }
  } catch {}
  return "";
}

// Returns true if the dangerous call is allowed (granted now or earlier for this
// page), false if the user denied it.
async function ensureRpcGrant(event, toolName, args) {
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return false;
  const origin = originOf(wc);
  if (_grants.get(wc.id) === origin) return true; // already allowed for this page

  const win = BrowserWindow.fromWebContents(wc) || BrowserWindow.getFocusedWindow() || null;
  const detail = [`来源: ${origin}`, `操作: ${toolName}`];
  const pv = previewArgs(toolName, args);
  if (pv) detail.push(pv);
  detail.push("", "该站点请求在你的电脑上执行命令 / 读写文件。只有你完全信任它时才允许。");

  let choice;
  try {
    choice = await dialog.showMessageBox(win, {
      type: "warning",
      noLink: true,
      buttons: ["拒绝", "允许一次", "本页面内允许"],
      defaultId: 0,
      cancelId: 0,
      title: "敏感操作请求",
      message: "站点要在本机执行敏感操作",
      detail: detail.join("\n"),
    });
  } catch { return false; }

  const response = choice && choice.response;
  if (response === 2) { // remember for this page
    _grants.set(wc.id, origin);
    if (!wc.__rpcGuardWired) {
      wc.__rpcGuardWired = true;
      const clear = () => _grants.delete(wc.id);
      wc.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) clear(); });
      wc.once("destroyed", clear);
    }
    audit({ kind: "auth", gate: "dangerous-tool", origin, tool: toolName, decision: "page-allow", temporary: true, args: pv });
    return true;
  }
  audit({ kind: "auth", gate: "dangerous-tool", origin, tool: toolName, decision: response === 1 ? "allow-once" : "deny", temporary: true, args: pv });
  return response === 1; // allow once
}

// ── Origin allowlist gate (domain-level trust-on-demand) ──────────────────────
// Distinct from the per-tool DANGEROUS gate above: this decides whether a page's
// ORIGIN may use the electronRPC bridge AT ALL. The bridge is now injected into
// every profile-0 tab, but it stays inert until the origin is authorized: a
// non-allowlisted origin's first rpc:guarded call pops a consent modal where the
// user can deny, allow for this run only, or add the domain to the persistent
// trusted-origins allowlist (so it's never asked again). This replaces the old
// "no bridge unless pre-trusted" behaviour with explicit, on-demand consent.
const _sessionOrigins = new Set(); // origin -> "本次允许" for this process lifetime
const _deniedOrigins = new Set();  // origin -> "拒绝" — sticky so a page can't spam modals
const _pendingByOrigin = new Map(); // origin -> in-flight modal promise (dedup races)

// Synchronous verdict for an origin WITHOUT prompting: "allow" | "deny" | "unknown".
// Lets a non-blocking caller (agent/skill, see main.js) decide instantly whether to
// proceed, refuse, or return a PENDING sentinel while the modal runs in the bg.
function originDecision(event) {
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return "deny";
  const url = wc.getURL();
  let isTrustedUrl;
  try { ({ isTrustedUrl } = require("./window-utils")); } catch {}
  if (isTrustedUrl && isTrustedUrl(url)) return "allow"; // on the allowlist
  const origin = originOf(wc);
  if (_sessionOrigins.has(origin)) return "allow"; // "本次允许" earlier
  if (_deniedOrigins.has(origin)) return "deny";   // blocked — settings = escape hatch
  return "unknown";
}

// Ensure the consent modal is running for this origin (deduped per origin). Returns
// the in-flight promise (resolves true/false). Safe to fire-and-forget: it records
// the outcome in _sessionOrigins/_deniedOrigins/the allowlist so a later
// originDecision() resolves it — that's how the agent's poll eventually succeeds.
function startOriginModal(event) {
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return Promise.resolve(false);
  const origin = originOf(wc);
  if (_pendingByOrigin.has(origin)) return _pendingByOrigin.get(origin); // dedup
  let host = "";
  try { host = new URL(wc.getURL()).hostname; } catch {}
  let refreshTrustedOrigins;
  try { ({ refreshTrustedOrigins } = require("./window-utils")); } catch {}

  const p = (async () => {
    const win = BrowserWindow.fromWebContents(wc) || BrowserWindow.getFocusedWindow() || null;
    let choice;
    try {
      choice = await dialog.showMessageBox(win, {
        type: "warning",
        noLink: true,
        buttons: ["拒绝", "本次允许", "信任此站点（加入白名单）"],
        defaultId: 0,
        cancelId: 0,
        title: "站点请求桌面 RPC 授权",
        message: "是否授权该站点使用桌面 RPC？",
        detail: [
          `来源: ${origin}`,
          "",
          "授权后，该站点可通过 electronRPC 调用本机工具（执行命令 / 读写文件等）。",
          "只有你完全信任它时才授权。",
          "「信任此站点」会把该域名加入白名单，以后不再询问。",
        ].join("\n"),
      });
    } catch { return false; }
    const r = choice && choice.response;
    if (r === 1) { // 本次允许 — temporary (process lifetime), record it so it isn't trace-less
      _sessionOrigins.add(origin);
      audit({ kind: "auth", gate: "origin", origin, decision: "session-allow", temporary: true });
      return true;
    }
    if (r === 2 && host) { // 加入白名单（持久）— trusted-origins-store.add() logs the allowlist change
      try {
        const res = require("../profiles/trusted-origins-store").add(host);
        if (!res || res.ok === false) return false;
        if (refreshTrustedOrigins) refreshTrustedOrigins();
        _sessionOrigins.add(origin);
        return true;
      } catch { return false; }
    }
    _deniedOrigins.add(origin); // 拒绝 / 关闭 — sticky for the session
    audit({ kind: "auth", gate: "origin", origin, decision: "deny", temporary: true });
    return false;
  })();
  _pendingByOrigin.set(origin, p);
  p.finally(() => _pendingByOrigin.delete(origin));
  return p;
}

// Blocking gate (in-page callers): resolve the verdict, prompting if undecided.
async function ensureOriginAuthorized(event) {
  const d = originDecision(event);
  if (d === "allow") return true;
  if (d === "deny") return false;
  return await startOriginModal(event);
}

module.exports = { DANGEROUS_TOOLS, isDangerousTool, ensureRpcGrant, ensureOriginAuthorized, originDecision, startOriginModal };
