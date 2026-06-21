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
// Full item templates (主人 spec): cicy-code needs the complete provider
// entries — protocol, model list, defaultModel — not just a bare key, or the
// CLIs can't pick a model. apiKey/url are filled in at injection time.
const GATEWAY_PROVIDER_TEMPLATES = {
  defaultAnthropic: {
    key: "defaultAnthropic",
    name: "CiCyAi",
    protocol: "anthropic",
    defaultModel: "deepseek-v4-pro",
    defaultModels: {},
    modelMapping: {},
    models: [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ],
    statusLabel: "Opus 4.8 (1M context)",
  },
  defaultOpenAi: {
    key: "defaultOpenAi",
    name: "CiCyAi",
    protocol: "openai",
    defaultModel: "deepseek-v4-pro",
    modelMapping: {},
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "gpt-5.5"],
  },
};

// Which provider slot each CLI routes to (providers.default in global.json).
// Filled in only where missing so a user's own routing override survives.
const GATEWAY_DEFAULT_ROUTING = {
  cicy: "defaultAnthropic",
  claude: "defaultAnthropic",
  codex: "defaultOpenAi",
  opencode: "defaultOpenAi",
  stt: "defaultOpenAi",
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

// A STABLE machine-level id, derived from the OS hardware/install UUID so it
// survives a wipe of ~/cicy-ai (deviceId lived there before → every wipe minted
// a NEW device in the cloud = zombie devices). Hashed so we never ship the raw
// machine id, and normalized to UUID shape across platforms. "" if unreadable.
function machineStableId() {
  try {
    const cp = require("child_process");
    const fs = require("fs");
    let raw = "";
    if (process.platform === "darwin") {
      const out = cp.execSync("ioreg -rd1 -c IOPlatformExpertDevice", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/);
      raw = m ? m[1] : "";
    } else if (process.platform === "win32") {
      const out = cp.execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      raw = m ? m[1] : "";
    } else {
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try { raw = fs.readFileSync(p, "utf8").trim(); if (raw) break; } catch {}
      }
    }
    raw = (raw || "").trim();
    if (!raw) return "";
    const h = crypto.createHash("sha256").update("cicy-device:" + raw).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  } catch {
    return "";
  }
}

// Stable per-machine device id, persisted in global.json so the SAME machine
// keeps one identity across restarts. Derived from machineStableId() so a wipe
// of global.json RE-DERIVES the same id (no zombie devices); a random UUID is
// only a last-resort fallback when the OS machine id is unreadable. A win box
// and a mac box each get their own (reported `platform` makes that explicit).
function getDeviceId() {
  const c = readGlobalConfig(GLOBAL_JSON);
  if (c && typeof c.deviceId === "string" && c.deviceId) return c.deviceId;
  const id = machineStableId() || crypto.randomUUID();
  updateGlobalConfig(GLOBAL_JSON, (cfg) => {
    if (!cfg.deviceId) cfg.deviceId = id;
    return cfg;
  });
  // Re-read in case a concurrent writer won the lock with a different id.
  return readGlobalConfig(GLOBAL_JSON).deviceId || id;
}

// Detect egress public IP + that IP's geo region. Runs in the Electron MAIN
// process where global `fetch` goes DIRECT — it does NOT use the Electron
// session proxy (主人令: 出口 IP 探测不能走 proxy). Each request has its own
// timeout via AbortController; never throws (returns empty/partial on failure).
async function detectIpGeo({ timeoutMs = 4000 } = {}) {
  const tryFetch = async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    } finally {
      clearTimeout(t);
    }
  };
  const empty = { country: "", region: "", city: "" };
  // ipinfo.io (https, no token for ip/city/region/country)
  let j = await tryFetch("https://ipinfo.io/json");
  if (j && typeof j.ip === "string" && j.ip) {
    return { publicIp: j.ip, ipRegion: { country: j.country || "", region: j.region || "", city: j.city || "" } };
  }
  // ip-api.com fallback ({ query, country, regionName, city })
  j = await tryFetch("http://ip-api.com/json");
  if (j && typeof j.query === "string" && j.query) {
    return { publicIp: j.query, ipRegion: { country: j.country || "", region: j.regionName || "", city: j.city || "" } };
  }
  // ipify last resort (ip only)
  j = await tryFetch("https://api.ipify.org?format=json");
  if (j && typeof j.ip === "string" && j.ip) {
    return { publicIp: j.ip, ipRegion: { ...empty } };
  }
  return { publicIp: "", ipRegion: { ...empty } };
}

// Back-compat thin wrapper — some callers only want the IP string.
async function getPublicIp(opts) {
  return (await detectIpGeo(opts)).publicIp;
}

// The persisted deviceInfo block in global.json (single source of truth).
function readDeviceInfo() {
  const c = readGlobalConfig(GLOBAL_JSON) || {};
  return c.deviceInfo && typeof c.deviceInfo === "object" ? c.deviceInfo : {};
}

// Flatten ipRegion ({country,region,city}) → "US / California / San Jose" for a
// clean, human-readable cloud device record (matches the SPA's representation).
// Pass-through if already a string.
function flattenIpRegion(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    return [r.country, r.region, r.city].map((x) => String(x || "").trim()).filter(Boolean).join(" / ");
  }
  return "";
}

// Instant, no-network: what the get_device_info RPC + cloud report read.
function getDeviceInfo() {
  const di = readDeviceInfo();
  return {
    deviceId: getDeviceId(),
    publicIp: di.publicIp || "",
    ipRegion: di.ipRegion && typeof di.ipRegion === "object" ? di.ipRegion : { country: "", region: "", city: "" },
    systemLanguage: di.systemLanguage || "",
    detectedAt: di.detectedAt || "",
  };
}

// Detect (network, no proxy, timeout) + merge systemLanguage (passed from the
// main process via electronApp.getLocale()) + persist to global.json. Never
// throws. Returns the persisted deviceInfo (incl. deviceId).
async function detectAndPersistDeviceInfo({ systemLanguage = "", timeoutMs = 4000 } = {}) {
  let geo = { publicIp: "", ipRegion: { country: "", region: "", city: "" } };
  try {
    geo = await detectIpGeo({ timeoutMs });
  } catch (_) {
    /* non-fatal */
  }
  try {
    updateGlobalConfig(GLOBAL_JSON, (cfg) => {
      const prev = cfg.deviceInfo && typeof cfg.deviceInfo === "object" ? cfg.deviceInfo : {};
      cfg.deviceInfo = {
        publicIp: geo.publicIp || prev.publicIp || "",
        ipRegion: geo.publicIp ? geo.ipRegion : prev.ipRegion || { country: "", region: "", city: "" },
        systemLanguage: String(systemLanguage || "") || prev.systemLanguage || "",
        detectedAt: new Date().toISOString(),
      };
      return cfg;
    });
  } catch (e) {
    log.warn(`[cloud] persist deviceInfo failed: ${e.message}`);
  }
  return getDeviceInfo();
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

async function registerDevice({ deviceId: deviceIdOverride = null } = {}) {
  const token = loginToken();
  if (!token) return { ok: false, reason: "not_logged_in" };
  // deviceId override:Docker 容器当作独立设备注册(host deviceId + "-docker"),
  // 这样它能拿到自己独立的 local team(云端按 device_id 复用一个 local team)。
  const deviceId = deviceIdOverride || getDeviceId();
  // Prefer the persisted deviceInfo (written by the startup task, which also has
  // the OS locale). If nothing detected yet, detect now (no syslang available here).
  let di = readDeviceInfo();
  if (!di || !di.publicIp) {
    di = await detectAndPersistDeviceInfo({ systemLanguage: (di && di.systemLanguage) || "" });
  }
  const body = {
    deviceId,
    platform: process.platform, // "win32" | "darwin" | "linux"
    arch: process.arch, // "x64" | "arm64"
  };
  if (di.publicIp) body.publicIp = di.publicIp;
  const region = flattenIpRegion(di.ipRegion);
  if (region) body.ipRegion = region;
  if (di.systemLanguage) body.systemLanguage = di.systemLanguage;
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
async function registerTeam({ teamId = null, title = "", titleVersion = 0, deviceId: deviceIdOverride = null } = {}) {
  const token = loginToken();
  if (!token) return { ok: false, reason: "not_logged_in" };
  const deviceId = deviceIdOverride || getDeviceId(); // Docker:传容器自己的 deviceId → 独立 team
  const body = { deviceId };
  if (teamId != null) body.teamId = teamId;
  if (title) body.title = title;
  // 服务端权威版本号(w-10032 契约,commit 06698533;旧 titleUpdatedAt 时间戳契约已废)。
  // 带上「最后一次从云端看到的」版本作为 base(没有就 0)。服务端乐观并发裁决:title 有变
  // 且 base>=云端当前版本 → 采用本端 title、版本=当前+1;否则忽略(base 落后=云端在我们
  // 上次同步后改过名 → 云端赢);相同 title 不 bump。客户端不再用自己的时钟。
  body.titleVersion = Number(titleVersion) || 0;
  const res = await cloudFetch("/api/team/register", { method: "POST", body });
  if (res.ok && res.json) {
    return {
      ok: true,
      teamId: res.json.teamId,
      apiKey: res.json.apiKey,
      gatewayUrl: res.json.gatewayUrl || GATEWAY_URL,
      protocols: res.json.protocols || ["anthropic", "openai"],
      title: res.json.title,                          // cloud's authoritative title
      titleVersion: Number(res.json.titleVersion) || 0, // cloud's authoritative version
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

// 建一个全新的独立 team(POST /api/teams)——不按 device 复用,每次建一个新的。
// Docker 用它:一机可以有多个 docker 容器,各自一个独立 team(8008 那个 local team
// 不动)。返回 { teamId, apiKey(=team token,既网关 key 也凭证), title, kind }。
async function createTeam({ title = "", kind = "cloud" } = {}) {
  const token = loginToken();
  if (!token) return { ok: false, reason: "not_logged_in" };
  const res = await cloudFetch("/api/teams", { method: "POST", body: { title, kind } });
  if (res.ok && res.json && res.json.team) {
    const t = res.json.team;
    return { ok: true, teamId: t.teamId || t.id, apiKey: t.apiKey || t.api_token, title: t.title, kind: t.kind, gatewayUrl: GATEWAY_URL };
  }
  log.warn(`[cloud] create team failed status=${res.status} reason=${res.reason || ""}`);
  return { ok: false, status: res.status, reason: res.reason };
}

// 按 teamId 取回某 team 的 token(网关 key)——建过之后重启只存 teamId,token 现取。
async function getTeamApiKey(teamId) {
  if (teamId == null) return null;
  const r = await listTeams();
  if (!r.ok) return null;
  const t = (r.teams || []).find((x) => String(x.teamId || x.id) === String(teamId));
  return t ? (t.apiKey || t.api_token || null) : null;
}

// ── gateway-key injection ─────────────────────────────────────────────────────

// Write the per-team gateway apiKey + url into the team's global.json:
// providers.default CLI routing (cicy/claude→anthropic slot, codex/opencode/
// stt→openai slot) plus full provider items keyed defaultAnthropic /
// defaultOpenAi (protocol, model list, defaultModel — cicy-code can't drive an
// LLM from a bare key). Existing entries keep user-tuned fields (model lists,
// routing overrides); only apiKey/url are forced and missing fields filled.
// No-ops (no write) when everything is already in place, so calling this on
// every launch is free. `globalJsonPath` defaults to the user-global config,
// which is also the local team's config home on this machine.
function injectGatewayKey(apiKey, gatewayUrl = GATEWAY_URL, globalJsonPath = GLOBAL_JSON) {
  if (!apiKey) throw new Error("injectGatewayKey: apiKey required");
  // Pre-check (updateGlobalConfig always rewrites the file): skip the write
  // when routing + both items are already exactly in place.
  try {
    const cur = readGlobalConfig(globalJsonPath);
    const p = cur.providers;
    // stt must specifically be on the gateway slot (defaultOpenAi), overriding
    // cicy-code's seeded "cloudflare-ai" — so require the exact value here, not
    // just "any truthy routing", or the pre-check would short-circuit the fix.
    const routed = p && p.default && Object.keys(GATEWAY_DEFAULT_ROUTING).every((cli) => p.default[cli]) && p.default.stt === "defaultOpenAi";
    const itemsOk = p && Array.isArray(p.items) && Object.entries(GATEWAY_PROVIDER_TEMPLATES).every(([key, tpl]) => {
      const it = p.items.find((x) => x && x.key === key);
      return it && it.apiKey === apiKey && it.url === gatewayUrl && Object.keys(tpl).every((f) => it[f] !== undefined);
    });
    if (routed && itemsOk) return { changed: false, config: cur };
  } catch {}
  let changed = false;
  const next = updateGlobalConfig(globalJsonPath, (cfg) => {
    if (!cfg.providers || typeof cfg.providers !== "object") cfg.providers = {};
    const p = cfg.providers;
    if (!p.default || typeof p.default !== "object") p.default = {};
    for (const [cli, slot] of Object.entries(GATEWAY_DEFAULT_ROUTING)) {
      if (!p.default[cli]) { p.default[cli] = slot; changed = true; }
    }
    // Force STT onto the gateway slot. cicy-code seeds default.stt="cloudflare-ai"
    // (direct-to-Cloudflare, needs .cf.prod creds), which the only-if-absent loop
    // above never overwrites. Route it through the gateway instead so STT is
    // metered via the team key and doesn't depend on local CF credentials.
    if (p.default.stt !== "defaultOpenAi") { p.default.stt = "defaultOpenAi"; changed = true; }
    if (!Array.isArray(p.items)) p.items = [];
    for (const [key, tpl] of Object.entries(GATEWAY_PROVIDER_TEMPLATES)) {
      let item = p.items.find((it) => it && it.key === key);
      if (!item) {
        p.items.push({ ...tpl, url: gatewayUrl, apiKey });
        changed = true;
        continue;
      }
      if (item.apiKey !== apiKey) { item.apiKey = apiKey; changed = true; }
      if (item.url !== gatewayUrl) { item.url = gatewayUrl; changed = true; }
      for (const [f, v] of Object.entries(tpl)) {
        if (item[f] === undefined) { item[f] = Array.isArray(v) ? [...v] : (v && typeof v === "object" ? { ...v } : v); changed = true; }
      }
    }
    return cfg;
  });
  return { changed, config: next };
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
  detectIpGeo,
  getDeviceInfo,
  detectAndPersistDeviceInfo,
  registerDevice,
  registerTeam,
  listTeams,
  createTeam,
  getTeamApiKey,
  injectGatewayKey,
  registerTeamAndInjectKey,
};
