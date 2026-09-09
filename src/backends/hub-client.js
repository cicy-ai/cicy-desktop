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
//   hub:projects     {id}     → that node's projects, each with its agents —
//                               read straight off the node's own API through its
//                               hub hostname (the gateway accepts the owner's hub
//                               token as bearer and swaps in the node's api token)
//
// The desktop registers itself as a hub instance (id `code-desktop-…`) because
// hub tokens are bound to (owner, instance). It never heartbeats, so it is
// hidden from the list on both sides.

const os = require("os");
const path = require("path");
const crypto = require("crypto");
const log = require("electron-log");
const { readGlobalConfig, updateGlobalConfig } = require("../utils/global-json");
const hubTrust = require("../utils/hub-trust");

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
  } catch {
    return null;
  }
}

// Stable per-machine hub instance id for this desktop (hub requires `code-` +
// 16..96 [A-Za-z0-9_-]).
function desktopInstanceId() {
  let id = "";
  try {
    id = String(readGlobalConfig(GLOBAL_JSON)?.hubDesktopInstanceId || "");
  } catch {}
  if (/^code-[A-Za-z0-9_-]{16,96}$/.test(id)) return id;
  id = "code-desktop-" + crypto.randomBytes(12).toString("hex");
  try {
    updateGlobalConfig(GLOBAL_JSON, (c) => {
      c.hubDesktopInstanceId = id;
      return c;
    });
  } catch {}
  return id;
}

// Electron's net.fetch goes through Chromium's network stack — it honours the
// OS proxy settings (PAC / system proxy) like the renderer does. Node's global
// fetch ignores them, which showed up as "fetch failed" on PCs that can only
// reach the hub through a proxy. Falls back to global fetch outside Electron.
function pickFetch() {
  try {
    const { net, app } = require("electron");
    if (net && typeof net.fetch === "function" && app && app.isReady()) return net.fetch.bind(net);
  } catch {}
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
      const r = await pickFetch()(hubOrigin() + route, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        cache: "no-store",
      });
      const text = await r.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: r.status, ok: r.ok, json, text };
    } catch (e) {
      lastErr = e;
      log.warn(`[hub] ${method} ${route} failed (${attempt + 1}/${tries}): ${e.message}`);
      if (attempt + 1 < tries) await new Promise((r) => setTimeout(r, 1500));
    } finally {
      clearTimeout(t);
    }
  }
  const msg = String((lastErr && lastErr.message) || lastErr || "fetch failed");
  throw new Error(
    /fetch failed|ECONN|ENOTFOUND|abort/i.test(msg)
      ? `hub unreachable (${hubOrigin()}): ${msg}`
      : msg
  );
}

// ── fallback: the local cicy-code sidecar ───────────────────────────────────
// Some PCs cannot reach the hub directly at all (no proxy on Windows) while the
// cicy-code container on the same PC can (it carries its own proxy) and is
// signed in to the same hub account. Its /api/im/cicy-cloud/* routes give us
// the same instance list and one-time open grants, so use them when the direct
// call dies with a network error.
const SIDECAR_PORT = Number(process.env.CICY_SIDECAR_PORT || 8008);
let _sidecarTok = { value: "", at: 0 };
async function sidecarToken() {
  if (_sidecarTok.value && Date.now() - _sidecarTok.at < 5 * 60 * 1000) return _sidecarTok.value;
  let tok = "";
  try {
    tok = String(readGlobalConfig(GLOBAL_JSON)?.api_token || "").trim();
  } catch {}
  if (!tok && process.platform === "win32") {
    try {
      tok = String(
        (await require("../sidecar/wsl-docker").readContainerToken(SIDECAR_PORT)) || ""
      ).trim();
    } catch (e) {
      log.warn(`[hub] sidecar token: ${e.message}`);
    }
  }
  if (tok) _sidecarTok = { value: tok, at: Date.now() };
  return tok;
}
async function sidecarFetch(route, { method = "GET", body = null } = {}) {
  const tok = await sidecarToken();
  if (!tok) throw new Error("local cicy-code token unavailable");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = { accept: "application/json", authorization: "Bearer " + tok };
    if (body != null) headers["content-type"] = "application/json";
    const r = await fetch(`http://127.0.0.1:${SIDECAR_PORT}${route}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, ok: r.ok, json, text };
  } finally {
    clearTimeout(t);
  }
}
const isNetErr = (e) =>
  /unreachable|fetch failed|ECONN|ENOTFOUND|abort/i.test(String((e && e.message) || e));

function errorOf(res, fallback) {
  return (
    (res && res.json && (res.json.error || res.json.message)) ||
    fallback ||
    `HTTP ${res && res.status}`
  );
}

function stopPending(reason) {
  if (_pending && _pending.timer) clearTimeout(_pending.timer);
  if (reason && _pending) log.info(`[hub] login stopped: ${reason}`);
  _pending = null;
}

function fire(payload) {
  try {
    _onResult && _onResult(payload);
  } catch {}
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
  const addr = String(email || "")
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new Error("invalid_email");
  stopPending("new login");
  _onResult = onResult;
  const instanceId = desktopInstanceId();
  const host = (os.hostname() || "desktop").split(".")[0];
  const name = `desktop-${host}-${instanceId.slice(-4)}`;
  const res = await hubFetch("/api/login/start", {
    method: "POST",
    body: { email: addr, instanceId, name, platform: "desktop-" + process.platform },
  });
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
  if (Date.now() - _pending.startedAt > LOGIN_TIMEOUT_MS) {
    stopPending("timeout");
    fire({ error: "timeout" });
    return;
  }
  try {
    const res = await hubFetch("/api/login/poll?state=" + encodeURIComponent(state));
    const j = res.json || {};
    if (j.status === "ready" && j.token) {
      const auth = {
        origin: hubOrigin(),
        token: j.token,
        owner: j.owner || _pending.email,
        instanceId: j.instanceId || desktopInstanceId(),
        savedAt: Date.now(),
      };
      updateGlobalConfig(GLOBAL_JSON, (c) => {
        c.hubAuth = auth;
        return c;
      });
      stopPending("ready");
      log.info(`[hub] signed in as ${auth.owner}`);
      fire({ ok: true, owner: auth.owner });
      return;
    }
    if (j.status === "expired") {
      stopPending("expired");
      fire({ error: "expired" });
      return;
    }
  } catch (e) {
    log.warn(`[hub] poll error (retrying): ${e.message}`);
  }
  schedulePoll(state);
}

async function loginCode({ code } = {}) {
  if (!_pending) throw new Error("no_pending_login");
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) throw new Error("invalid_code");
  const res = await hubFetch("/api/login/code", {
    method: "POST",
    body: { state: _pending.state, code: c },
  });
  if (!res.ok) throw new Error(errorOf(res, "invalid_code"));
  // approved → the very next poll hands over the token
  if (_pending.timer) clearTimeout(_pending.timer);
  await pollOnce(_pending.state);
  return { ok: true };
}

function cancel() {
  if (_pending) {
    stopPending("cancelled");
    fire({ error: "cancelled" });
  }
  return { ok: true };
}

function clearAuth() {
  try {
    updateGlobalConfig(GLOBAL_JSON, (c) => {
      delete c.hubAuth;
      return c;
    });
  } catch {}
  try {
    hubTrust.clearOwnerHubHost();
  } catch {}
}

async function instances() {
  const a = readAuth();
  if (!a) return { ok: false, error: "not_logged_in", instances: [] };
  let res,
    viaSidecar = false;
  try {
    res = await hubFetch("/api/instances", { token: a.token });
  } catch (e) {
    if (!isNetErr(e)) return { ok: false, error: e.message, instances: [] };
    log.warn(`[hub] direct instance list failed (${e.message}); trying the local cicy-code`);
    try {
      res = await sidecarFetch("/api/im/cicy-cloud/instances");
      viaSidecar = true;
    } catch (e2) {
      return { ok: false, error: `${e.message}; sidecar: ${e2.message}`, instances: [] };
    }
  }
  if (res.status === 401 && !viaSidecar) {
    clearAuth();
    return { ok: false, error: "unauthorized", instances: [] };
  }
  if (!res.ok || !res.json)
    return { ok: false, error: errorOf(res, "instances_failed"), instances: [] };
  const list = Array.isArray(res.json.instances) ? res.json.instances : [];
  const out = list
    // direct: `self` is this desktop's hidden pseudo-instance; via sidecar: `self` is the
    // local node itself, which IS a real instance the user may want to open.
    // Viewer logins (this desktop, other desktops, phones) are not machines.
    .filter((i) => (viaSidecar || !i.self) && !/^(desktop|mobile)/.test(String(i.platform || "")))
    .map((i) => ({
      id: i.instanceId,
      name: i.name || (i.proxyHost ? String(i.proxyHost).split(".")[0] : i.instanceId),
      host: i.proxyHost || "",
      url: i.proxyHost ? "https://" + i.proxyHost : "",
      online: i.status ? i.status === "online" : !!i.online,
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
      // The node's last agent snapshot (agentId/title/status/model/working…).
      agentList: Array.isArray(i.agents) ? i.agents : [],
    }))
    .sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
  // Every host in this list was fetched with the owner's own token, so each one
  // provably belongs to the owner's tenant — trust the whole set for owner-scoped
  // dangerous RPC (each node is served at its own <node>.hub.cicy-ai.com subdomain).
  try {
    hubTrust.recordOwnerHubHosts(out.map((i) => i.host));
  } catch {}
  _lastInstances = out;
  return { ok: true, owner: res.json.owner || a.owner, viaSidecar, instances: out };
}

// ── node drill-down: projects → agents ──────────────────────────────────────
// Every instance host is the node's own cicy-code API; the hub gateway lets the
// owner's hub token through (swapping in the node's api token), so the desktop
// can read /api/groups (projects), /api/panes and /api/poll directly — no
// cookie session, no per-node credential.
let _lastInstances = [];
const NODE_TIMEOUT_MS = 15_000;

async function nodeFetch(host, route, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NODE_TIMEOUT_MS);
  try {
    const r = await pickFetch()("https://" + host + route, {
      headers: { accept: "application/json", authorization: "Bearer " + token },
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!r.ok) throw new Error(`${route}: HTTP ${r.status}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

const shortWid = (paneId) => String(paneId || "").split(":")[0];

async function projects({ id } = {}) {
  const a = readAuth();
  if (!a) return { ok: false, error: "not_logged_in", projects: [] };
  let inst = _lastInstances.find((i) => i.id === id);
  if (!inst) {
    const r = await instances();
    inst = (r.instances || []).find((i) => i.id === id);
  }
  if (!inst || !inst.host) return { ok: false, error: "instance_not_found", projects: [] };
  const [groupsRes, panesRes, pollRes] = await Promise.all([
    nodeFetch(inst.host, "/api/groups", a.token).catch(() => null),
    nodeFetch(inst.host, "/api/panes", a.token),
    nodeFetch(inst.host, "/api/poll", a.token).catch(() => null),
  ]);
  const groups = Array.isArray(groupsRes) ? groupsRes : (groupsRes && groupsRes.groups) || [];
  const panes = (Array.isArray(panesRes) ? panesRes : (panesRes && panesRes.panes) || []).filter(
    (p) => p && typeof p.pane_id === "string" && p.pane_id
  );
  const statuses = (pollRes && pollRes.statuses) || {};
  const pollRows = new Map();
  for (const row of (pollRes && pollRes.agents) || [])
    if (row && row.name) pollRows.set(String(row.name), row);
  // Every pane on the node is an agent (masters included).
  const agents = new Map();
  for (const p of panes) {
    const wid = shortWid(p.pane_id);
    if (!wid || agents.has(wid)) continue;
    const row = pollRows.get(wid) || {};
    agents.set(wid, {
      wid,
      title: p.title || row.title || wid,
      agentType: p.agent_type || row.agent_type || "",
      role: p.role || "",
      status: String(statuses[p.pane_id] || statuses[wid] || row.status || ""),
      model: p.default_model || "",
      workspace: p.workspace || "",
    });
  }
  const placed = new Set();
  const out = [];
  for (const g of groups) {
    const ids = new Set((g.pane_ids || []).map(shortWid));
    const members = [...agents.values()].filter((x) => ids.has(x.wid) && !placed.has(x.wid));
    for (const m of members) placed.add(m.wid);
    if (!members.length && !g.is_default) continue;
    out.push({
      id: String(g.id),
      name: g.name || String(g.project_template || g.id),
      slug: g.project_template || "",
      agents: members,
    });
  }
  const rest = [...agents.values()].filter((x) => !placed.has(x.wid));
  if (rest.length) out.push({ id: "ungrouped", name: "", slug: "", agents: rest });
  return { ok: true, host: inst.host, projects: out };
}

// One-time hand-off URL for an instance (optionally one of its local ports).
async function grantUrl({ id, port = 0, next = "/" } = {}) {
  const a = readAuth();
  if (!a) throw new Error("not_logged_in");
  let res;
  try {
    res = await hubFetch("/api/gateway/grant", {
      method: "POST",
      token: a.token,
      body: { instanceId: String(id || ""), port: Number(port) || 0, next: String(next || "/") },
    });
  } catch (e) {
    if (!isNetErr(e)) throw e;
    log.warn(`[hub] direct grant failed (${e.message}); trying the local cicy-code`);
    res = await sidecarFetch("/api/im/cicy-cloud/open", {
      method: "POST",
      body: { instance_id: String(id || ""), port: Number(port) || 0, next: String(next || "/") },
    });
    if (!res.ok || !res.json || !res.json.url) throw new Error(errorOf(res, "grant_failed"));
    try {
      hubTrust.recordOwnerHubHost(res.json.host);
    } catch {}
    return { url: res.json.url, host: res.json.host };
  }
  if (res.status === 401) {
    clearAuth();
    throw new Error("unauthorized");
  }
  if (!res.ok || !res.json || !res.json.url) throw new Error(errorOf(res, "grant_failed"));
  // The grant was minted with THIS desktop's own hubAuth token, so its host
  // provably belongs to the owner email — trust it for owner-scoped dangerous RPC.
  try {
    hubTrust.recordOwnerHubHost(res.json.host);
  } catch {}
  return { url: res.json.url, host: res.json.host };
}

async function logout() {
  const a = readAuth();
  if (a) {
    try {
      await hubFetch("/api/logout", { method: "POST", token: a.token });
    } catch {}
  }
  clearAuth();
  stopPending("logout");
  return { ok: true };
}

module.exports = {
  status,
  loginStart,
  loginCode,
  cancel,
  instances,
  projects,
  grantUrl,
  logout,
  hubOrigin,
};
