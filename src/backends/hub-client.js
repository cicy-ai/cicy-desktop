// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// CiCy Hub client — the desktop signs in to the hub (cicy-ws-hub) with nothing
// but an email address and then lists every cicy-code instance of that tenant
// (same email = same tenant), so the homepage shows all of the user's nodes
// without adding them one by one as custom teams. No local cicy-code needed.
//
//   hub:login-start  {email}  → mail with a 6-digit code + magic link; we poll
//   hub:login-code   {code}   → approves the pending login without the mail link
//   hub:instances             → same-owner instances (+ online, version, resources)
//   hub:open         {id}     → one-time grant URL → opened as a team tab; the
//                               grant sets the domain-wide hub session cookie so
//                               later opens need no login at all
//
// The desktop registers itself as a hub instance (id `code-desktop-…`) because
// hub tokens are bound to (owner, instance). It never heartbeats, so it is
// hidden from the list on both sides.

const os = require("os");
const path = require("path");
const crypto = require("crypto");
const log = require("electron-log");
const { readGlobalConfig, updateGlobalConfig } = require("../utils/global-json");

const GLOBAL_JSON = path.join(os.homedir(), "cicy-ai", "global.json");
const DEFAULT_ORIGIN = "https://ws.cicy-ai.com";
const POLL_EVERY_MS = 2500;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000; // hub loginTTL
const FETCH_TIMEOUT_MS = 20_000;

let _pending = null; // { state, email, startedAt, timer }
let _onResult = null;

function hubOrigin() {
  const env = String(process.env.CICY_HUB_ORIGIN || "").trim();
  if (env) return env.replace(/\/+$/, "");
  try {
    const c = readGlobalConfig(GLOBAL_JSON);
    const o = c && c.hubAuth && c.hubAuth.origin;
    if (o) return String(o).replace(/\/+$/, "");
  } catch {}
  return DEFAULT_ORIGIN;
}

function readAuth() {
  try {
    const c = readGlobalConfig(GLOBAL_JSON);
    const a = c && c.hubAuth;
    return a && a.token ? a : null;
  } catch { return null; }
}

// Stable per-machine hub instance id for this desktop (hub requires `code-` +
// 16..96 [A-Za-z0-9_-]).
function desktopInstanceId() {
  let id = "";
  try { id = String(readGlobalConfig(GLOBAL_JSON)?.hubDesktopInstanceId || ""); } catch {}
  if (/^code-[A-Za-z0-9_-]{16,96}$/.test(id)) return id;
  id = "code-desktop-" + crypto.randomBytes(12).toString("hex");
  try { updateGlobalConfig(GLOBAL_JSON, (c) => { c.hubDesktopInstanceId = id; return c; }); } catch {}
  return id;
}

// Electron's net.fetch goes through Chromium's network stack — it honours the
// OS proxy settings (PAC / system proxy) like the renderer does. Node's global
// fetch ignores them, which showed up as "fetch failed" on PCs that can only
// reach the hub through a proxy. Falls back to global fetch outside Electron.
function pickFetch() {
  try { const { net, app } = require("electron"); if (net && typeof net.fetch === "function" && app && app.isReady()) return net.fetch.bind(net); } catch {}
  return fetch;
}

async function hubFetch(route, { method = "GET", token = "", body = null, tries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = { accept: "application/json" };
      if (token) headers.authorization = "Bearer " + token;
      if (body != null) headers["content-type"] = "application/json";
      const r = await pickFetch()(hubOrigin() + route, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: ctrl.signal, cache: "no-store" });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return { status: r.status, ok: r.ok, json, text };
    } catch (e) {
      lastErr = e;
      log.warn(`[hub] ${method} ${route} failed (${attempt + 1}/${tries}): ${e.message}`);
      if (attempt + 1 < tries) await new Promise((r) => setTimeout(r, 1500));
    } finally { clearTimeout(t); }
  }
  const msg = String((lastErr && lastErr.message) || lastErr || "fetch failed");
  throw new Error(/fetch failed|ECONN|ENOTFOUND|abort/i.test(msg) ? `hub unreachable (${hubOrigin()}): ${msg}` : msg);
}

function errorOf(res, fallback) {
  return (res && res.json && (res.json.error || res.json.message)) || fallback || `HTTP ${res && res.status}`;
}

function stopPending(reason) {
  if (_pending && _pending.timer) clearTimeout(_pending.timer);
  if (reason && _pending) log.info(`[hub] login stopped: ${reason}`);
  _pending = null;
}

function fire(payload) {
  try { _onResult && _onResult(payload); } catch {}
}

function status() {
  const a = readAuth();
  return {
    origin: hubOrigin(),
    loggedIn: !!a,
    owner: a ? a.owner || "" : "",
    pending: _pending ? { state: _pending.state, email: _pending.email } : null,
  };
}

async function loginStart({ email, onResult } = {}) {
  const addr = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new Error("invalid_email");
  stopPending("new login");
  _onResult = onResult;
  const instanceId = desktopInstanceId();
  const host = (os.hostname() || "desktop").split(".")[0];
  const name = `desktop-${host}-${instanceId.slice(-4)}`;
  const res = await hubFetch("/api/login/start", { method: "POST", body: { email: addr, instanceId, name, platform: "desktop-" + process.platform } });
  if (!res.ok || !res.json || !res.json.state) throw new Error(errorOf(res, "login_start_failed"));
  const state = res.json.state;
  _pending = { state, email: addr, startedAt: Date.now(), timer: null };
  log.info(`[hub] login started for ${addr}`);
  schedulePoll(state);
  return { state, email: addr, expiresInSec: res.json.expiresInSec || 0 };
}

function schedulePoll(state, delay = POLL_EVERY_MS) {
  if (!_pending || _pending.state !== state) return;
  _pending.timer = setTimeout(() => pollOnce(state), delay);
}

async function pollOnce(state) {
  if (!_pending || _pending.state !== state) return;
  if (Date.now() - _pending.startedAt > LOGIN_TIMEOUT_MS) { stopPending("timeout"); fire({ error: "timeout" }); return; }
  try {
    const res = await hubFetch("/api/login/poll?state=" + encodeURIComponent(state));
    const j = res.json || {};
    if (j.status === "ready" && j.token) {
      const auth = { origin: hubOrigin(), token: j.token, owner: j.owner || _pending.email, instanceId: j.instanceId || desktopInstanceId(), savedAt: Date.now() };
      updateGlobalConfig(GLOBAL_JSON, (c) => { c.hubAuth = auth; return c; });
      stopPending("ready");
      log.info(`[hub] signed in as ${auth.owner}`);
      fire({ ok: true, owner: auth.owner });
      return;
    }
    if (j.status === "expired") { stopPending("expired"); fire({ error: "expired" }); return; }
  } catch (e) {
    log.warn(`[hub] poll error (retrying): ${e.message}`);
  }
  schedulePoll(state);
}

async function loginCode({ code } = {}) {
  if (!_pending) throw new Error("no_pending_login");
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) throw new Error("invalid_code");
  const res = await hubFetch("/api/login/code", { method: "POST", body: { state: _pending.state, code: c } });
  if (!res.ok) throw new Error(errorOf(res, "invalid_code"));
  // approved → the very next poll hands over the token
  if (_pending.timer) clearTimeout(_pending.timer);
  await pollOnce(_pending.state);
  return { ok: true };
}

function cancel() {
  if (_pending) { stopPending("cancelled"); fire({ error: "cancelled" }); }
  return { ok: true };
}

function clearAuth() {
  try { updateGlobalConfig(GLOBAL_JSON, (c) => { delete c.hubAuth; return c; }); } catch {}
}

async function instances() {
  const a = readAuth();
  if (!a) return { ok: false, error: "not_logged_in", instances: [] };
  let res;
  try { res = await hubFetch("/api/instances", { token: a.token }); }
  catch (e) { return { ok: false, error: e.message, instances: [] }; }
  if (res.status === 401) { clearAuth(); return { ok: false, error: "unauthorized", instances: [] }; }
  if (!res.ok || !res.json) return { ok: false, error: errorOf(res, "instances_failed"), instances: [] };
  const list = Array.isArray(res.json.instances) ? res.json.instances : [];
  const out = list
    .filter((i) => !i.self && !String(i.platform || "").startsWith("desktop"))
    .map((i) => ({
      id: i.instanceId,
      name: i.name || i.proxyHost || i.instanceId,
      host: i.proxyHost || "",
      url: i.proxyHost ? "https://" + i.proxyHost : "",
      online: !!i.online,
      reachable: !!i.proxyAvailable,
      version: i.version || "",
      platform: i.platform || "",
      arch: i.arch || "",
      lastSeenAt: i.lastSeenAt || "",
      cpuCores: i.cpuCores || 0,
      memoryTotalMB: i.memoryTotalMB || 0,
      resources: i.resources || null,
      ports: Array.isArray(i.ports) ? i.ports : [],
      agents: Array.isArray(i.agents) ? i.agents.length : undefined,
    }))
    .sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
  return { ok: true, owner: res.json.owner || a.owner, instances: out };
}

// One-time hand-off URL for an instance (optionally one of its local ports).
async function grantUrl({ id, port = 0, next = "/" } = {}) {
  const a = readAuth();
  if (!a) throw new Error("not_logged_in");
  const res = await hubFetch("/api/gateway/grant", { method: "POST", token: a.token, body: { instanceId: String(id || ""), port: Number(port) || 0, next: String(next || "/") } });
  if (res.status === 401) { clearAuth(); throw new Error("unauthorized"); }
  if (!res.ok || !res.json || !res.json.url) throw new Error(errorOf(res, "grant_failed"));
  return { url: res.json.url, host: res.json.host };
}

async function logout() {
  const a = readAuth();
  if (a) { try { await hubFetch("/api/logout", { method: "POST", token: a.token }); } catch {} }
  clearAuth();
  stopPending("logout");
  return { ok: true };
}

module.exports = { status, loginStart, loginCode, cancel, instances, grantUrl, logout, hubOrigin };
