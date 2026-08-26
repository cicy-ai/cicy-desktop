// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Trusted-origins allowlist — the EXACT-hostname set of sites permitted to
// receive the electronRPC bridge in profile 0 (i.e. allowed to run exec_shell &
// friends on THIS machine). Persisted at ~/cicy-ai/db/trusted-origins.json as
// { "origins": ["app.example.com", …] }.
//
// This is the ONLY user-controlled source of trust (see window-utils.isTrustedUrl).
//   • localhost / 127.0.0.1 are always trusted (built-in, non-removable).
//   • Everything else must be added explicitly here (Chrome-style site settings).
//   • Adding a team / backend does NOT grant trust — "add a server" must never
//     implicitly hand a remote origin the ability to run commands locally.
//   • There is deliberately NO domain-suffix wildcard (a public-upload host like
//     r2.deepfetch.de5.net under a trusted suffix would otherwise become a trusted
//     RPC source).
const fs = require("fs");
const os = require("os");
const path = require("path");
let _audit = () => {};
try { _audit = require("../utils/rpc-audit").audit; } catch {}

const STORE = path.join(os.homedir(), "cicy-ai", "db", "trusted-origins.json");
const BUILTIN = ["localhost", "127.0.0.1"]; // always trusted, cannot be removed

// Normalize arbitrary user input to a bare hostname:
//   "https://X.Com/path?q" → "x.com",  "x.com:3000" → "x.com",  "  x.com " → "x.com".
// Returns "" when nothing usable / invalid.
function normalizeHost(input) {
  if (!input || typeof input !== "string") return "";
  let s = input.trim().toLowerCase();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try { return new URL(s).hostname; } catch { return ""; }
  }
  s = s.split("/")[0].split("?")[0].split("#")[0]; // drop path/query/fragment
  s = s.replace(/:\d+$/, "");                       // drop :port
  if (!/^[a-z0-9._-]+$/.test(s)) return "";         // basic host charset (underscore is legal in real-world hostnames, e.g. xs_master.example.com)
  if (s.startsWith(".") || s.endsWith(".") || s.includes("..")) return "";
  return s;
}

function readRaw() {
  try {
    if (!fs.existsSync(STORE)) return [];
    const j = JSON.parse(fs.readFileSync(STORE, "utf-8")) || {};
    return Array.isArray(j.origins) ? j.origins : [];
  } catch { return []; }
}

function writeRaw(origins, dangerous) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const cur = readRawObj();
  const next = { origins, dangerous: Array.isArray(dangerous) ? dangerous : (Array.isArray(cur.dangerous) ? cur.dangerous : []) };
  fs.writeFileSync(STORE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STORE, 0o600); } catch {}
}
function readRawObj() {
  try { if (!fs.existsSync(STORE)) return {}; const j = JSON.parse(fs.readFileSync(STORE, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}

// "此站点始终允许敏感操作":对已在白名单里的站点,持久跳过 exec/读写文件的逐次确认。
// 只有白名单站点可以加入(不在白名单 → 拒绝),从白名单移除时一并撤销。
function listDangerousAllowed() {
  const set = new Set(listUser());
  return (Array.isArray(readRawObj().dangerous) ? readRawObj().dangerous : []).map(normalizeHost).filter((h) => h && set.has(h));
}
function isDangerousAllowed(host) {
  const h = normalizeHost(host);
  return !!h && listDangerousAllowed().includes(h);
}
function allowDangerous(input) {
  const host = normalizeHost(input);
  if (!host) return { ok: false, error: "无效的站点地址" };
  if (!listAll().includes(host)) return { ok: false, error: "站点不在白名单中" };
  const cur = listDangerousAllowed();
  if (!cur.includes(host)) { writeRaw(listUser(), [...cur, host]); _audit({ kind: "auth", gate: "allowlist", host, decision: "dangerous-always-allow" }); }
  return { ok: true };
}
function revokeDangerous(input) {
  const host = normalizeHost(input);
  const cur = listDangerousAllowed();
  if (cur.includes(host)) { writeRaw(listUser(), cur.filter((h) => h !== host)); _audit({ kind: "auth", gate: "allowlist", host, decision: "dangerous-revoke" }); }
  return { ok: true };
}

// User-managed origins only (normalized, de-duped, built-ins excluded).
function listUser() {
  const seen = new Set();
  const out = [];
  for (const h of readRaw()) {
    const n = normalizeHost(h);
    if (n && !BUILTIN.includes(n) && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// The full trusted set consumed by isTrustedUrl(): built-ins ∪ user list.
function listAll() {
  return [...BUILTIN, ...listUser()];
}

// UI shape: each row tagged builtin (greyed / non-removable) or user.
function listForUi() {
  return [
    ...BUILTIN.map((host) => ({ host, builtin: true })),
    ...listUser().map((host) => ({ host, builtin: false })),
  ];
}

function add(input) {
  const host = normalizeHost(input);
  if (!host) return { ok: false, error: "无效的站点地址" };
  if (BUILTIN.includes(host)) return { ok: true, origins: listForUi() }; // already trusted
  const cur = listUser();
  if (!cur.includes(host)) { writeRaw([...cur, host]); _audit({ kind: "auth", gate: "allowlist", host, decision: "trust-add" }); }
  return { ok: true, origins: listForUi() };
}

function remove(input) {
  const host = normalizeHost(input);
  if (BUILTIN.includes(host)) return { ok: false, error: "内置站点不可删除" };
  const cur = listUser();
  if (cur.includes(host)) { writeRaw(cur.filter((h) => h !== host), listDangerousAllowed().filter((h) => h !== host)); _audit({ kind: "auth", gate: "allowlist", host, decision: "trust-remove" }); }
  return { ok: true, origins: listForUi() };
}

module.exports = { STORE, BUILTIN, normalizeHost, listUser, listAll, listForUi, add, remove, listDangerousAllowed, isDangerousAllowed, allowDangerous, revokeDangerous };
