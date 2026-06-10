// Cloud ⇄ cicy-desktop client (device / team / teams).
//
// Implements the contract agreed with the cloud side (w-10032), documented at
// cicy-ai/cloud-device-team-api.md:
//   ① POST /api/device/register  — on app launch, report this machine
//   ② POST /api/team/register     — before a local team starts, get its gateway key
//   ③ GET  /api/teams             — list the user's cloud + local teams
//
// Data model (主人定): user → many devices (win/mac distinguished by a stable
// per-machine deviceId) → many local teams per device → one gateway key per team.
//
// Auth: every call carries `Authorization: Bearer <desktop login token>` — the
// magic-link token persisted in global.json's `desktopAuth.token`. The cloud
// resolves owner (= login email) from it. When the user is NOT logged in, every
// entry point here is a no-op that returns { ok:false, reason:"not_logged_in" }
// so callers can stay oblivious.
//
// All HTTP runs in the Electron MAIN process where global `fetch` has
// unrestricted network access (no CORS, unlike the file:// renderer).

const os = require("os");
const path = require("path");
const crypto = require("crypto");
const log = require("electron-log");
const { readGlobalConfig, updateGlobalConfig } = require("../utils/global-json");

const CLOUD_BASE = process.env.CICY_CLOUD_BASE || "https://cicy-ai.com";
const GATEWAY_URL = process.env.CICY_GATEWAY_URL || "https://gateway.cicy-ai.com";
const GLOBAL_JSON = path.join(os.homedir(), "cicy-ai", "global.json");

// The two provider slots the gateway key must land in, per the contract.
const GATEWAY_PROVIDER_KEYS = {
  defaultAnthropic: "anthropic",
  defaultOpenAi: "openai",
};

// ── token / identity ────────────────────────────────────────────────────────

// The desktop login (magic-link) bearer token, or "" when not logged in.
function loginToken() {
  try {
    const c = readGlobalConfig(GLOBAL_JSON);
    return (c && c.desktopAuth && c.desktopAuth.token) || "";
  } catch (e) {
    log.warn(`[cloud] read login token failed: ${e.message}`);
    return "";
  }
}

// Stable per-machine UUID. Generated once and persisted in global.json so the
// SAME machine keeps one identity across restarts; a win box and a mac box each
// get their own (the `platform` field reported alongside makes that explicit).
function getDeviceId() {
  const c = readGlobalConfig(GLOBAL_JSON);
  if (c && typeof c.deviceId === "string" && c.deviceId) return c.deviceId;
  const id = crypto.randomUUID();
  updateGlobalConfig(GLOBAL_JSON, (cfg) => {
    if (!cfg.deviceId) cfg.deviceId = id;
    return cfg;
  });
  // Re-read in case a concurrent writer won the lock with a different id.
  return readGlobalConfig(GLOBAL_JSON).deviceId || id;
}

// Best-effort public IP. Optional in the contract (cloud falls back to the peer
// IP), so a failure here is non-fatal — we just send no publicIp.
async function getPublicIp({ timeoutMs = 4000 } = {}) {
  const services = [
    "https://api.ipify.org?format=json", // { ip }
    "https://ipinfo.io/json", // { ip, ... }
  ];
  for (const url of services) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && typeof j.ip === "string" && j.ip) return j.ip;
    } catch (_) {
      /* try next */
    }
  }
  return "";
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

async function cloudFetch(endpoint, { method = "GET", body = null } = {}) {
  const token = loginToken();
  if (!token) return { ok: false, status: 0, reason: "not_logged_in" };
  const url = `${CLOUD_BASE}${endpoint}`;
  const headers = { Authorization: `Bearer ${token}` };
  if (body != null) headers["Content-Type"] = "application/json";
  try {
    const r = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : null,
      cache: "no-store",
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      /* non-JSON body */
    }
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    log.warn(`[cloud] ${method} ${endpoint} failed: ${e.message}`);
    return { ok: false, status: 0, reason: "network_error", error: e.message };
  }
}

// ── ① device/register ───────────────────────────────────────────────────────

async function registerDevice() {
  const token = loginToken();
  if (!token) return { ok: false, reason: "not_logged_in" };
  const deviceId = getDeviceId();
  const publicIp = await getPublicIp();
  const body = {
    deviceId,
    platform: process.platform, // "win32" | "darwin" | "linux"
    arch: process.arch, // "x64" | "arm64"
  };
  if (publicIp) body.publicIp = publicIp;
  const res = await cloudFetch("/api/device/register", { method: "POST", body });
  if (res.ok) {
    log.info(`[cloud] device registered deviceId=${deviceId} platform=${body.platform}/${body.arch}`);
  } else {
    log.warn(`[cloud] device register failed status=${res.status} reason=${res.reason || ""}`);
  }
  return { ...res, deviceId };
}

// ── ② team/register ─────────────────────────────────────────────────────────

// Register (or idempotently re-fetch) a local team's gateway key.
//   teamId omitted → cloud creates a new team + key.
//   teamId given   → cloud returns that team's existing key (no rotation).
// Returns { ok, teamId, apiKey, gatewayUrl } on success.
async function registerTeam({ teamId = null, title = "" } = {}) {
  const token = loginToken();
  if (!token) return { ok: false, reason: "not_logged_in" };
  const deviceId = getDeviceId();
  const body = { deviceId };
  if (teamId != null) body.teamId = teamId;
  if (title) body.title = title;
  const res = await cloudFetch("/api/team/register", { method: "POST", body });
  if (res.ok && res.json) {
    return {
      ok: true,
      teamId: res.json.teamId,
      apiKey: res.json.apiKey,
      gatewayUrl: res.json.gatewayUrl || GATEWAY_URL,
      protocols: res.json.protocols || ["anthropic", "openai"],
    };
  }
  log.warn(`[cloud] team register failed status=${res.status} reason=${res.reason || ""}`);
  return { ok: false, status: res.status, reason: res.reason, json: res.json };
}

// ── ③ teams ─────────────────────────────────────────────────────────────────

async function listTeams({ deviceId = null, kind = null } = {}) {
  const token = loginToken();
  if (!token) return { ok: false, reason: "not_logged_in", teams: [] };
  const qs = [];
  if (deviceId) qs.push(`deviceId=${encodeURIComponent(deviceId)}`);
  if (kind) qs.push(`kind=${encodeURIComponent(kind)}`);
  const ep = `/api/teams${qs.length ? `?${qs.join("&")}` : ""}`;
  const res = await cloudFetch(ep, { method: "GET" });
  if (res.ok && res.json && Array.isArray(res.json.teams)) {
    return { ok: true, teams: res.json.teams };
  }
  log.warn(`[cloud] teams list failed status=${res.status} reason=${res.reason || ""}`);
  return { ok: false, status: res.status, reason: res.reason, teams: [] };
}

// ── gateway-key injection ─────────────────────────────────────────────────────

// Write the per-team gateway apiKey + url into the team's global.json
// providers.items entries keyed defaultAnthropic / defaultOpenAi. Existing
// entries are updated in place (preserving model lists etc.); missing ones are
// created minimally. `globalJsonPath` defaults to the user-global config, which
// is also the local team's config home on this machine.
function injectGatewayKey(apiKey, gatewayUrl = GATEWAY_URL, globalJsonPath = GLOBAL_JSON) {
  if (!apiKey) throw new Error("injectGatewayKey: apiKey required");
  return updateGlobalConfig(globalJsonPath, (cfg) => {
    if (!cfg.providers || typeof cfg.providers !== "object") cfg.providers = {};
    if (!Array.isArray(cfg.providers.items)) cfg.providers.items = [];
    const items = cfg.providers.items;
    for (const [key, protocol] of Object.entries(GATEWAY_PROVIDER_KEYS)) {
      let item = items.find((it) => it && it.key === key);
      if (!item) {
        item = { key, protocol, name: "CiCyAi", url: gatewayUrl, apiKey };
        items.push(item);
      } else {
        item.apiKey = apiKey;
        item.url = gatewayUrl;
        if (!item.protocol) item.protocol = protocol;
      }
    }
    return cfg;
  });
}

// Convenience: register a team and immediately wire its key into the local
// team's global.json. `teamId` persists across calls so re-runs are idempotent
// (no key rotation). Caller supplies a getter/setter for where teamId lives.
async function registerTeamAndInjectKey({ teamId = null, title = "", globalJsonPath = GLOBAL_JSON } = {}) {
  const reg = await registerTeam({ teamId, title });
  if (!reg.ok) return reg;
  try {
    injectGatewayKey(reg.apiKey, reg.gatewayUrl, globalJsonPath);
    log.info(`[cloud] gateway key injected into ${globalJsonPath} (teamId=${reg.teamId})`);
  } catch (e) {
    log.warn(`[cloud] key injection failed: ${e.message}`);
    return { ...reg, injected: false, injectError: e.message };
  }
  return { ...reg, injected: true };
}

module.exports = {
  CLOUD_BASE,
  GATEWAY_URL,
  GLOBAL_JSON,
  loginToken,
  getDeviceId,
  getPublicIp,
  registerDevice,
  registerTeam,
  listTeams,
  injectGatewayKey,
  registerTeamAndInjectKey,
};
