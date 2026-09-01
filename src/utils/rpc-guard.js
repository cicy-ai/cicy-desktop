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
const hubTrust = require("./hub-trust");

// Host code-exec + host filesystem tools = the RCE surface.
const DANGEROUS_TOOLS = new Set([
  "exec_shell",
  "exec_python",
  "exec_node",
  "exec_shell_file",
  "exec_python_file",
  "exec_node_file",
  "file_read",
  "file_write",
  "file_upload",
  "file_download",
  "electron_inject",
]);
function isDangerousTool(t) {
  return DANGEROUS_TOOLS.has(t);
}

// webContents.id -> granted origin (page-scoped; cleared on cross-doc nav / destroy).
const _grants = new Map();
// wc.id -> in-flight danger-consent promise (dedup: an unattended fleet node was
// stacking one modal per agent retry — the origin gate already dedups this way).
const _pendingGrantByWc = new Map();
// wc.id -> { origin, at } — short-lived record of a "允许一次" click so the
// non-blocking (polling) transport's very next retry gets through. The click
// resolves a promise nobody awaits, so without this the next poll just re-pops
// the modal forever. Expires on its own; origin-scoped (see grantDecision).
const _grantOnceByWc = new Map();
const GRANT_ONCE_MS = 20 * 1000;

// The URL of the FRAME that actually sent the IPC. An <iframe> has its own URL,
// distinct from the top-level webContents (wc.getURL()). Every trust decision
// MUST key on this: otherwise a subframe (third-party embed, or an injected
// <iframe src=attacker>) inherits the top page's trust — and on the owner-hub
// origin that means zero-click exec_* (RCE). Falls back to the top-frame URL only
// when senderFrame is gone (frame disposed mid-call), where the call fails anyway.
function frameUrl(event) {
  try {
    const f = event && event.senderFrame;
    if (f && typeof f.url === "string" && f.url) return f.url;
  } catch {}
  try {
    const wc = event && event.sender;
    if (wc && !wc.isDestroyed()) return wc.getURL() || "";
  } catch {}
  return "";
}
function originFromUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url || "(unknown)";
  }
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

// Synchronous danger verdict WITHOUT prompting: "allow" | "unknown".
// (There is no sticky "deny" for the per-tool gate — a denial is a one-off.)
// Lets the non-blocking agent transport decide instantly: proceed, or pop the
// modal in the background and hand back a PENDING sentinel the caller polls on.
function grantDecision(event, toolName) {
  if (!isDangerousTool(toolName)) return "allow";
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return "unknown";
  const url = frameUrl(event); // the ACTUAL calling frame, not the top page
  const origin = originFromUrl(url);
  // Owner's own ws-hub control surface (logged in + host proven by a hub grant)
  // → the operator commanding their own machine; no click to gate on.
  if (hubTrust.isOwnerHubOrigin(url)) return "allow";
  if (_grants.get(wc.id) === origin) return "allow"; // granted earlier this page
  // A recent "允许一次" for this exact origin, still within its short window.
  const once = _grantOnceByWc.get(wc.id);
  if (once && once.origin === origin && Date.now() - once.at < GRANT_ONCE_MS) return "allow";
  if (once) _grantOnceByWc.delete(wc.id); // expired or origin changed
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  let store = null;
  try {
    store = require("../profiles/trusted-origins-store");
  } catch {}
  if (store && host && store.isDangerousAllowed(host)) return "allow"; // 白名单 + 「始终允许」
  return "unknown";
}

// Returns true if the dangerous call is allowed (granted now or earlier for this
// page / owner-trusted), false if the user denied it. Blocking path for in-page
// callers; the modal is deduped per wc so retries can't stack consent dialogs.
async function ensureRpcGrant(event, toolName, args) {
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return false;
  if (grantDecision(event, toolName) === "allow") return true;
  if (_pendingGrantByWc.has(wc.id)) return _pendingGrantByWc.get(wc.id); // dedup in-flight
  const p = _runGrantModal(event, toolName, args);
  _pendingGrantByWc.set(wc.id, p);
  p.finally(() => {
    if (_pendingGrantByWc.get(wc.id) === p) _pendingGrantByWc.delete(wc.id);
  });
  return p;
}

// The actual consent dialog (only reached for an undecided origin).
async function _runGrantModal(event, toolName, args) {
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return false;
  const url = frameUrl(event);
  const origin = originFromUrl(url);
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  let store = null;
  try {
    store = require("../profiles/trusted-origins-store");
  } catch {}
  const canAlways = !!(store && host && store.listAll().includes(host));

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
      buttons: canAlways
        ? ["拒绝", "允许一次", "本页面内允许", "此站点始终允许（不再询问）"]
        : ["拒绝", "允许一次", "本页面内允许"],
      defaultId: 0,
      cancelId: 0,
      title: "敏感操作请求",
      message: "站点要在本机执行敏感操作",
      detail: detail.join("\n"),
    });
  } catch {
    return false;
  }

  const response = choice && choice.response;
  if (response === 3 && canAlways) {
    // persistent: allowlisted site, never ask again for dangerous tools
    try {
      store.allowDangerous(host);
    } catch {}
    _grants.set(wc.id, origin);
    audit({
      kind: "auth",
      gate: "dangerous-tool",
      origin,
      tool: toolName,
      decision: "always-allow",
      temporary: false,
      args: pv,
    });
    return true;
  }
  if (response === 2) {
    // remember for this page
    _grants.set(wc.id, origin);
    if (!wc.__rpcGuardWired) {
      wc.__rpcGuardWired = true;
      const clear = () => _grants.delete(wc.id);
      wc.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) clear();
      });
      wc.once("destroyed", clear);
    }
    audit({
      kind: "auth",
      gate: "dangerous-tool",
      origin,
      tool: toolName,
      decision: "page-allow",
      temporary: true,
      args: pv,
    });
    return true;
  }
  if (response === 1) {
    // 允许一次 — an in-page awaiter gets `true` returned directly (as before);
    // the non-blocking poller has already been handed PENDING, so record the
    // grant briefly here or its next retry would just re-pop this modal.
    _grantOnceByWc.set(wc.id, { origin, at: Date.now() });
    audit({
      kind: "auth",
      gate: "dangerous-tool",
      origin,
      tool: toolName,
      decision: "allow-once",
      temporary: true,
      args: pv,
    });
    return true;
  }
  audit({
    kind: "auth",
    gate: "dangerous-tool",
    origin,
    tool: toolName,
    decision: "deny",
    temporary: true,
    args: pv,
  });
  return false;
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
// origin -> deny timestamp. A deny is sticky only for DENY_COOLDOWN_MS so a page
// can't spam modals, but a mistaken "拒绝" (or a modal that timed out unattended)
// no longer locks the origin out for the whole process lifetime — the user gets
// asked again after the cooldown instead of having to find the settings page.
const DENY_COOLDOWN_MS = 60 * 1000;
const _deniedOrigins = new Map();
const _pendingByOrigin = new Map(); // origin -> in-flight modal promise (dedup races)

// Synchronous verdict for an origin WITHOUT prompting: "allow" | "deny" | "unknown".
// Lets a non-blocking caller (agent/skill, see main.js) decide instantly whether to
// proceed, refuse, or return a PENDING sentinel while the modal runs in the bg.
function originDecision(event) {
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return "deny";
  const url = frameUrl(event); // the ACTUAL calling frame, not the top page
  // Owner's own ws-hub control surface (logged in + host proven by a hub grant)
  // may use the bridge without an allowlist entry — it IS the operator.
  if (hubTrust.isOwnerHubOrigin(url)) return "allow";
  let isTrustedUrl;
  try {
    ({ isTrustedUrl } = require("./window-utils"));
  } catch {}
  if (isTrustedUrl && isTrustedUrl(url)) return "allow"; // on the allowlist
  const origin = originFromUrl(url);
  if (_sessionOrigins.has(origin)) return "allow"; // "本次允许" earlier
  const deniedAt = _deniedOrigins.get(origin);
  if (deniedAt && Date.now() - deniedAt < DENY_COOLDOWN_MS) return "deny"; // recently refused
  if (deniedAt) _deniedOrigins.delete(origin); // cooldown over → ask again
  return "unknown";
}

// Ensure the consent modal is running for this origin (deduped per origin). Returns
// the in-flight promise (resolves true/false). Safe to fire-and-forget: it records
// the outcome in _sessionOrigins/_deniedOrigins/the allowlist so a later
// originDecision() resolves it — that's how the agent's poll eventually succeeds.
function startOriginModal(event) {
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return Promise.resolve(false);
  const url = frameUrl(event);
  const origin = originFromUrl(url);
  if (_pendingByOrigin.has(origin)) return _pendingByOrigin.get(origin); // dedup
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  let refreshTrustedOrigins;
  try {
    ({ refreshTrustedOrigins } = require("./window-utils"));
  } catch {}

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
    } catch {
      return false;
    }
    const r = choice && choice.response;
    if (r === 1) {
      // 本次允许 — temporary (process lifetime), record it so it isn't trace-less
      _sessionOrigins.add(origin);
      audit({ kind: "auth", gate: "origin", origin, decision: "session-allow", temporary: true });
      return true;
    }
    if (r === 2 && host) {
      // 加入白名单（持久）— trusted-origins-store.add() logs the allowlist change
      let res = null,
        err = "";
      try {
        res = require("../profiles/trusted-origins-store").add(host);
      } catch (e) {
        err = e && e.message;
      }
      if (res && res.ok !== false) {
        if (refreshTrustedOrigins) refreshTrustedOrigins();
        _sessionOrigins.add(origin);
        return true;
      }
      // The user explicitly chose to trust the site; if persisting the allowlist
      // failed, honour the intent for this run and SAY why — silently returning
      // false here made the modal reappear on every call with no explanation.
      _sessionOrigins.add(origin);
      audit({
        kind: "auth",
        gate: "origin",
        origin,
        decision: "session-allow",
        temporary: true,
        error: `allowlist-add-failed: ${(res && res.error) || err || "unknown"}`,
      });
      try {
        dialog
          .showMessageBox(win, {
            type: "error",
            noLink: true,
            buttons: ["知道了"],
            title: "加入白名单失败",
            message: `无法把 ${host} 加入受信任站点`,
            detail: `${(res && res.error) || err || "未知错误"}\n\n本次已允许该站点；下次启动会再次询问。你也可以在 头像 → 受信任站点 里手动添加。`,
          })
          .catch(() => {});
      } catch {}
      return true;
    }
    _deniedOrigins.set(origin, Date.now()); // 拒绝 / 关闭 — sticky for DENY_COOLDOWN_MS
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

// Background danger-consent for the non-blocking transport: ensure the modal is
// running (deduped per wc) and record its outcome, so a later grantDecision()
// resolves — same poll-until-granted contract as startOriginModal().
function startGrantModal(event, toolName, args) {
  const wc = event && event.sender;
  if (!wc || wc.isDestroyed()) return Promise.resolve(false);
  if (_pendingGrantByWc.has(wc.id)) return _pendingGrantByWc.get(wc.id);
  const p = _runGrantModal(event, toolName, args);
  _pendingGrantByWc.set(wc.id, p);
  p.finally(() => {
    if (_pendingGrantByWc.get(wc.id) === p) _pendingGrantByWc.delete(wc.id);
  });
  return p;
}

module.exports = {
  DENY_COOLDOWN_MS,
  DANGEROUS_TOOLS,
  isDangerousTool,
  ensureRpcGrant,
  grantDecision,
  startGrantModal,
  ensureOriginAuthorized,
  originDecision,
  startOriginModal,
};
