// Local-teams discovery — reads ~/cicy-ai/global.json and pings each
// configured node's /api/health. Local-only by design: this module never
// talks to the cloud, never runs `docker ps`, and never invents nodes
// the user didn't explicitly register. The single source of truth is
// `cicyDesktopNodes` in global.json.
//
// Why no docker probing: an earlier attempt fanned out `docker version`,
// `docker images`, `docker inspect`, `docker ps` on a 5s tick. On a Mac
// where Docker Desktop's daemon was half-dead each call took 32 s to
// time out, which starved libuv's threadpool and made the renderer's
// startup feel "卡死". Reading global.json + an HTTP GET on 127.0.0.1
// is cheap and contention-free.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const net = require("net");
const { execFile } = require("child_process");
const { spawn } = require("child_process");
const { BrowserWindow } = require("electron");
// i18n for the default team name ("Unnamed"/"未命名"/…). Resolved at create
// time from the app locale; falls back to "Unnamed" if i18n isn't ready.
let __t;
try { __t = require("../i18n").t; } catch { __t = null; }
const unnamedName = () => { try { return (__t && __t("localTeams.unnamed")) || "Unnamed"; } catch { return "Unnamed"; } };
const log = require("electron-log");

// global.json is now only read for the local sidecar's api_token (auto-fill).
// The TEAM LIST lives in its own file: ~/cicy-ai/db/teams.json — decoupled from
// global.json (which cicy-code + the helper self-register into, which used to
// leak "Unnamed" ghosts into the team list). Shape: a flat { "<id>": {node} } map.
const GLOBAL_JSON = path.join(os.homedir(), "cicy-ai", "global.json");
const TEAMS_JSON = path.join(os.homedir(), "cicy-ai", "db", "teams.json");
const HEALTH_TIMEOUT_MS = 1500;
const PORT_TIMEOUT_MS = 700; // raw TCP-connect liveness for the LOCAL sidecar
const CACHE_MS = 4000; // small dedupe so rapid renderer polls don't fan-out

let _cache = null;
let _cacheUntil = 0;

function readGlobal() {
  try {
    const raw = fs.readFileSync(GLOBAL_JSON, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    if (e && e.code !== "ENOENT") log.info(`[local-teams] read failed: ${e.message}`);
    return null;
  }
}

// The team map, from teams.json. One-time migration: if teams.json is absent
// but the legacy global.json.cicyDesktopNodes still has teams, seed teams.json
// from it (global.json is left untouched). Returns a { "<id>": {node} } map.
function readNodes() {
  try {
    const raw = fs.readFileSync(TEAMS_JSON, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (e) {
    if (e && e.code !== "ENOENT") log.info(`[local-teams] teams.json read failed: ${e.message}`);
  }
  const legacy = (readGlobal()?.cicyDesktopNodes) || {};
  if (Object.keys(legacy).length) {
    try {
      fs.mkdirSync(path.dirname(TEAMS_JSON), { recursive: true });
      fs.writeFileSync(TEAMS_JSON, JSON.stringify(legacy, null, 2), { mode: 0o600 });
      log.info(`[local-teams] migrated ${Object.keys(legacy).length} team(s) global.json → teams.json`);
    } catch (e) { log.info(`[local-teams] teams.json migrate failed: ${e.message}`); }
    return legacy;
  }
  return {};
}

// Atomic read-modify-write of teams.json. The updater gets the node map and
// returns the next map. Seeds from legacy global.json on first write too.
async function writeNodes(updater) {
  let nodes = {};
  try {
    const raw = await fs.promises.readFile(TEAMS_JSON, "utf8");
    nodes = JSON.parse(raw);
    if (!nodes || typeof nodes !== "object") nodes = {};
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    nodes = (readGlobal()?.cicyDesktopNodes) || {}; // seed from legacy
  }
  const next = updater(nodes) || nodes;
  const tmp = `${TEAMS_JSON}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.mkdir(path.dirname(TEAMS_JSON), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, TEAMS_JSON);
  _cacheUntil = 0; // invalidate list() cache
  return next;
}

function probeHealth(baseUrl, token) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(baseUrl); }
    catch { return resolve({ ok: false, error: "bad_url" }); }
    const lib = parsed.protocol === "https:" ? https : http;
    const port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port,
      path: "/api/health",
      headers,
      timeout: HEALTH_TIMEOUT_MS,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; if (body.length > 8192) body = body.slice(0, 8192); });
      res.on("end", () => {
        // 版本解析唯一来源:require("../sidecar/version").parseHealthVersion
        const ver = require("../sidecar/version").parseHealthVersion(body);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          version: ver,
        });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.code || e.message || "error" }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
  });
}

// Raw TCP-connect liveness: is ANYTHING listening on host:port? A successful
// connect means the daemon's socket is up — even if it's mid-boot or busy and
// /api/health hasn't answered yet. This is the authoritative "is it alive" for
// the LOCAL sidecar: /api/health is a heavy, blockable signal, so timing it out
// used to mis-classify a live-but-busy daemon as "stopped" — which made the card
// offer 启动并打开 and a click would spawn a SECOND cicy-code racing for :8008.
function probePort(hostname, port, timeoutMs = PORT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: hostname, port }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false)); // ECONNREFUSED → nothing listening
  });
}

function classify(health) {
  if (health.ok) return "running";
  if (health.status === 401 || health.status === 403) return "auth_error";
  if (health.error === "timeout") return "stopped";
  if (health.error === "ECONNREFUSED" || health.error === "ECONNRESET" || health.error === "EHOSTUNREACH") return "stopped";
  if (health.error === "bad_url") return "misconfigured";
  return "error";
}

// Liveness for one team. LOCAL sidecar: TCP-port-listening is authoritative
// (never down-grade a listening daemon to "stopped"), /api/health only enriches
// version/auth. REMOTE/cloud (https): the port is a CDN that's always "open", so
// /api/health stays authoritative there.
async function probeLiveness(baseUrl, token) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch { return { status: "misconfigured", version: null, error: "bad_url" }; }
  const isLocal = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (isLocal) {
    const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    const open = await probePort(parsed.hostname, port);
    if (!open) return { status: "stopped", version: null, error: "port_closed" };
    const health = await probeHealth(baseUrl, token); // best-effort enrichment
    if (health.status === 401 || health.status === 403) return { status: "auth_error", version: health.version || null, error: null };
    // Port is listening → the daemon is up. Health timing out just means busy.
    return { status: "running", version: health.version || null, error: health.ok ? null : (health.error || null) };
  }
  const health = await probeHealth(baseUrl, token);
  return { status: classify(health), version: health.version || null, error: health.error || null };
}

async function list({ refresh = false } = {}) {
  if (!refresh && _cache && Date.now() < _cacheUntil) return _cache;
  const nodes = readNodes();
  const slugs = Object.keys(nodes);
  const teams = await Promise.all(slugs.map(async (slug) => {
    const node = nodes[slug] || {};
    const baseUrl = node.base_url || "";
    let port = null;
    try { port = parseInt(new URL(baseUrl).port, 10) || null; } catch {}
    const live = await probeLiveness(baseUrl, node.api_token);
    return {
      id: slug,
      name: node.name || slug,
      base_url: baseUrl,
      api_token: node.api_token || "",
      // Cloud-issued teamId (from name-sync register). The renderer maps it to
      // the team's sk-cicy- gateway apiKey (via /api/teams) for the 账单 link —
      // the local api_token is an MCP token the cloud can't bill on.
      cloud_team_id: node.cloud_team_id || null,
      port,
      install_source: node.install_source || null,
      install_os: node.install_os || null,
      install_arch: node.install_arch || null,
      install_path: node.install_path || null,
      container_name: node.container_name || null,
      image: node.image || null,
      status: live.status,
      version: live.version || null,
      error: live.error || null,
    };
  }));
  _cache = teams;
  _cacheUntil = Date.now() + CACHE_MS;
  return teams;
}

// Open the team's web UI. Logic mirrors the user's spec: check
// get_windows (BrowserWindow.getAllWindows) first; if a window already
// shows this team's origin+pathname, bring it to front and return its
// id. Otherwise route through createWindow() (same path as the
// `open_window` tool) so the new window picks up the trust gate +
// dom-ready electronRPC injection — bare `new BrowserWindow` strips
// the SPA of every desktop tool, which was the regression in the
// previous implementation.
async function openTeam(id) {
  const node = readNodes()[id];
  if (!node) return { ok: false, error: "team not found" };
  const baseUrl = (node.base_url || "").replace(/\/$/, "");
  if (!baseUrl) return { ok: false, error: "no base_url" };
  const token = node.api_token || "";
  const url = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : baseUrl;

  // Compare by origin+pathname only — token + hash both vary per
  // session, so a strict equality match would never reuse.
  const targetKey = stripVolatile(url);
  const existing = BrowserWindow.getAllWindows().find((w) => {
    if (!w || w.isDestroyed()) return false;
    try { return stripVolatile(w.webContents.getURL()) === targetKey; }
    catch { return false; }
  });

  if (existing) {
    try { if (existing.isMinimized()) existing.restore(); } catch {}
    try { existing.show(); } catch {}
    try { existing.focus(); } catch {}
    // A reused window can be STUCK at the login screen (its original load
    // had a stale/absent token, e.g. after a token rotation) — focusing it
    // would loop the user at login forever. If the page holds no token,
    // re-navigate with the current ?token= so the SPA can consume it. An
    // authenticated workspace (token present) is left untouched.
    if (token) {
      try {
        const hasTok = await existing.webContents.executeJavaScript(
          "!!localStorage.getItem('api_token')", true);
        if (!hasTok) {
          log.info(`[local-teams] open ${id} → reused win.id=${existing.id} had no token, re-navigating`);
          existing.loadURL(url);
        }
      } catch { /* page not ready / JS blocked — leave as-is */ }
    }
    log.info(`[local-teams] open ${id} → reused win.id=${existing.id}`);
    return { ok: true, windowId: existing.id, reused: true };
  }

  // No window yet. Before opening one against a LOCAL sidecar, make sure the
  // daemon is REALLY up (TCP 探活) — opening a window at a not-yet-ready :8008
  // loads a blank page the user has to manually reload (主人 bug). Start it if
  // it isn't running, then poll until it answers; bail (no blank window) if it
  // never comes up. Remote/custom (non-localhost) teams skip this — their page
  // shows its own connecting/login UI.
  if (isLocalOrigin(url)) {
    const ready = await ensureLocalSidecarAlive(url);
    if (!ready) {
      log.warn(`[local-teams] open ${id} → local sidecar not ready, not opening blank window`);
      return { ok: false, error: "sidecar_not_ready" };
    }
  }

  // Open the team as a TAB in account 0's tab browser (一个 profile 一个窗口，
  // 不再每次弹新窗口). trusted=true → the tab gets the electronRPC bridge so the
  // cicy-code SPA keeps working. Falls back to a real window on any failure so
  // opening a team is never blocked.
  try {
    const tabBrowser = require("../tools/tab-browser-tools");
    // tab name = the team's title (not the cicy-code SPA's document.title)
    const r = await tabBrowser.openTab(0, url, { trusted: true, systemOpen: true, title: node.name || id });
    log.info(`[local-teams] open ${id} → tab in win.id=${r.winId} (reused=${r.reused})`);
    return { ok: true, windowId: r.winId, reused: !!r.reused, tabbed: true };
  } catch (e) {
    log.warn(`[local-teams] open ${id} → tab failed (${e.message}); falling back to window`);
    const { createWindow } = require("../utils/window-utils");
    const win = createWindow(
      { url, title: `Local · ${node.name || id}` },
      0,    // accountIdx — local teams all share account 0's session partition
      true, // forceNew — we already determined no match above
    );
    log.info(`[local-teams] open ${id} → new win.id=${win.id}`);
    return { ok: true, windowId: win.id, reused: false };
  }
}

// Is this URL served by something on the local machine (the cicy-code sidecar)?
function isLocalOrigin(url) {
  try { const h = new URL(url).hostname; return h === "127.0.0.1" || h === "localhost" || h === "::1"; }
  catch { return false; }
}

// Ensure the local cicy-code daemon serving `url` actually answers before we
// open a window at it. Already up → true immediately. Down → start it, then
// poll a TCP probe (NOT /api/health, which is unreliable mid-boot) until it
// binds or we time out.
async function ensureLocalSidecarAlive(url, { timeoutMs = 15000 } = {}) {
  let port;
  try { port = Number(new URL(url).port) || 8008; } catch { return true; } // unparseable → don't block
  let sidecar;
  try { sidecar = require("../sidecar/cicy-code"); } catch { return true; }
  if (await sidecar.probeExisting(port)) return true;       // already answering
  try { await sidecar.start({ port }); } catch {}            // not up → bring it up
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await sidecar.probeExisting(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function stripVolatile(u) {
  try {
    const p = new URL(u);
    return `${p.origin}${p.pathname}`;
  } catch { return u; }
}

// Reload the web content of this team's already-open window (the homepage's
// 刷新 action). Matches the window the same way openTeam reuses one — by
// origin+pathname. No-op-with-error if no window is open for the team.
function reloadTeam(id) {
  const node = readNodes()[id];
  if (!node) return { ok: false, error: "team not found" };
  const baseUrl = (node.base_url || "").replace(/\/$/, "");
  if (!baseUrl) return { ok: false, error: "no base_url" };
  const token = node.api_token || "";
  const url = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : baseUrl;
  const targetKey = stripVolatile(url);
  const win = BrowserWindow.getAllWindows().find((w) => {
    if (!w || w.isDestroyed()) return false;
    try { return stripVolatile(w.webContents.getURL()) === targetKey; }
    catch { return false; }
  });
  if (!win) return { ok: false, error: "no_open_window" };
  try {
    win.webContents.reload();
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    log.info(`[local-teams] reload ${id} → win.id=${win.id}`);
    return { ok: true, windowId: win.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Close any open window served by the local sidecar (origin
// http://127.0.0.1:<port> or http://localhost:<port>). Called when the sidecar
// is STOPPED so a now-dead :8008 team window doesn't linger showing a broken
// page (主人 bug report: stop 后应关掉 localhost 的 window).
function closeLocalWindows(port = 8008) {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  let closed = 0;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue;
    let origin = "";
    try { origin = new URL(w.webContents.getURL()).origin; } catch { continue; }
    if (origins.has(origin)) {
      try { w.close(); closed++; } catch {}
    }
  }
  if (closed) log.info(`[local-teams] closed ${closed} local window(s) on :${port} after stop`);
  return closed;
}

// ── mutations ──────────────────────────────────────────────────────────
//
// add/remove/upgrade let an external caller (currently the cloud Team
// Helper agent, via `agent-webpage exec-js`) register the just-installed
// local cicy-code as a managed team. Single source of truth is still
// `cicyDesktopNodes` in ~/cicy-ai/global.json; we read-modify-write
// atomically (tmp + rename) so a half-written file never lands.

const fsp = fs.promises;

function slugifyId(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}


// Dedupe key for a team: host:port only. The same cicy-code node is the same
// node across platforms/protocols, so protocol, path and token never affect
// identity — one host:port = one team. (Was protocol+host+port+path, which
// treated http vs https or /a vs /b as different teams.)
function normaliseUrl(u) {
  try {
    const p = new URL(String(u || "").trim());
    const port = p.port || (p.protocol === "https:" ? "443" : "80");
    return `${p.hostname.toLowerCase()}:${port}`;
  } catch { return ""; }
}

// Sync THIS device's local team title to the cloud (desktop→cloud, one-way;
// 主人 + w-10032 spec). Best-effort: a cloud failure NEVER blocks the local
// create/rename. Persists the cloud-assigned teamId so later renames UPDATE the
// same row (POST /api/team/register with teamId) instead of creating dupes.
// Only local-origin teams sync — a custom remote team isn't "this device's
// local team". No-op when logged out.
async function syncNameToCloud(id) {
  let cc;
  try { cc = require("../cloud/cloud-client"); } catch { return; }
  try {
    if (!cc.loginToken || !cc.loginToken()) return; // not logged in
    const node = readNodes()[id];
    if (!node || !isLocalOrigin(node.base_url || "")) return;
    let reg = await cc.registerTeam({ teamId: node.cloud_team_id || null, title: node.name || "", titleVersion: node.titleVersion || 0 });
    // Self-heal a STALE cached cloud_team_id: if we presented a cached id but the
    // cloud returned ok WITHOUT an apiKey (team deleted / rotated / no longer owned
    // cloud-side — e.g. after a cloud wipe), the cached id is dead. Re-register with
    // teamId=null to mint a FRESH team+key instead of silently leaving the gateway
    // key empty (the "apiKey stays empty after a cloud wipe → requests 发不出去" bug).
    // The teamId-changed branch below persists the new id back into teams.json.
    if (reg && reg.ok && !reg.apiKey && node.cloud_team_id) {
      log.warn(`[local-teams] cached cloud_team_id=${node.cloud_team_id} returned no gateway key — re-creating a fresh team`);
      reg = await cc.registerTeam({ teamId: null, title: node.name || "", titleVersion: node.titleVersion || 0 });
    }
    // The cloud assigns this team a sk-cicy- gateway apiKey on register — wire
    // it (full provider items + CLI routing, 主人 spec) into this machine's
    // global.json so cicy-code has an LLM key from the moment it starts.
    // Idempotent: injectGatewayKey no-ops when everything is already in place.
    if (reg && reg.ok && reg.apiKey) {
      try {
        const inj = cc.injectGatewayKey(reg.apiKey, reg.gatewayUrl);
        if (inj && inj.changed) log.info(`[local-teams] gateway key injected into global.json (teamId=${reg.teamId})`);
      } catch (e) { log.warn(`[local-teams] gateway key injection failed: ${e.message}`); }
    }
    if (reg && reg.ok) {
      // 服务端权威版本号裁决(w-10032 契约):响应版本 > 本地 → 采用响应的 title+version。
      // 一条规则覆盖三种情况:(a) 云端/别处改名下行(reg.title=云端名,版本更大);
      // (b) 本端改名被接受(reg.title=本端名,版本=base+1);(c) 冲突被拒(base 落后→
      // reg.title=云端名,版本更大→云端赢)。相同名服务端不 bump→版本不变→不动。
      const respVer = Number(reg.titleVersion) || 0;
      const localVer = Number(node.titleVersion) || 0;
      const adopt = respVer > localVer;
      const teamIdChanged = reg.teamId && reg.teamId !== node.cloud_team_id;
      if (teamIdChanged || adopt) {
        await writeNodes((nodes) => {
          if (nodes[id]) {
            if (teamIdChanged) nodes[id].cloud_team_id = reg.teamId;
            if (adopt) { if (reg.title) nodes[id].name = reg.title; nodes[id].titleVersion = respVer; }
          }
          return nodes;
        });
      }
      if (adopt) log.info(`[local-teams] cloud title-sync ${id} ← "${reg.title}" v${respVer} (was v${localVer})`);
      else if (teamIdChanged) log.info(`[local-teams] cloud title-sync ${id} → teamId=${reg.teamId}`);
    }
  } catch (e) { log.warn(`[local-teams] cloud title-sync ${id} failed: ${e.message}`); }
}

// Sync EVERY existing local-origin team to cloud. Runs once at startup (after
// login) so teams that were created BEFORE the cloud-client existed — or that
// live on a freshly-deployed machine (e.g. a Windows box whose 本地团队 predates
// this code) — register to cloud without needing a manual rename to trigger it.
// create/rename still sync individually; this is the catch-up for the rest.
// Best-effort, fully non-blocking, no-op when logged out.
async function syncAllLocalTeams() {
  try {
    const cc = require("../cloud/cloud-client");
    if (!cc.loginToken || !cc.loginToken()) return; // logged out → no-op
    const nodes = readNodes();
    const ids = Object.keys(nodes).filter((id) => isLocalOrigin(nodes[id]?.base_url || ""));
    for (const id of ids) {
      try { await syncNameToCloud(id); } catch {}
    }
    if (ids.length) log.info(`[local-teams] startup cloud-sync of ${ids.length} local team(s)`);
  } catch (e) { log.warn(`[local-teams] startup cloud-sync failed: ${e.message}`); }
}

async function addTeam(spec) {
  if (!spec || typeof spec !== "object") return { ok: false, error: "spec required" };
  const baseUrlRaw = String(spec.base_url || "").trim();
  if (!baseUrlRaw) return { ok: false, error: "base_url required" };
  try { new URL(baseUrlRaw); } catch { return { ok: false, error: "bad base_url" }; }
  const baseUrl = baseUrlRaw.replace(/\/$/, "");
  const baseUrlKey = normaliseUrl(baseUrl);
  let port = null;
  try { port = parseInt(new URL(baseUrl).port, 10) || null; } catch {}

  // Token auto-fill: when the team is on localhost, cicy-code and cicy-desktop
  // share the same `~/cicy-ai/global.json` and the daemon's own api_token is
  // already there. The cloud Team Helper agent regularly forgets to read +
  // pass it, leaving the swap URL with no `?token=` and stranding the user
  // at a login screen. Auto-fill from local global.json (top-level api_token)
  // so the common case "Just Works", even when spec.api_token is empty.
  if (!spec.api_token) {
    try {
      const host = new URL(baseUrl).hostname;
      if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
        const gLocal = readGlobal();
        if (gLocal?.api_token) {
          spec = { ...spec, api_token: String(gLocal.api_token) };
          log.info(`[local-teams] addTeam: auto-filled api_token from global.json for ${baseUrl}`);
        }
      }
    } catch {}
  }

  // base_url is the dedupe key: if a team with the same URL already exists
  // we upsert it (refresh token + install meta), never create a duplicate.
  // This is what the user sees in the helper flow — "rerun the installer
  // on the same port" should rotate the token in place, not pile on a
  // second card.
  const existing = readNodes();
  let existingId = null;
  for (const [k, v] of Object.entries(existing)) {
    if (normaliseUrl(v?.base_url || "") === baseUrlKey) { existingId = k; break; }
  }

  // Derive the id from the host:port key so it CAN'T collide: two different
  // nodes never share an id (different host:port → different slug), and the
  // same node always hits existingId above. (Was spec.name || local-<port>,
  // which made two hosts on the same port — or same name — overwrite each
  // other.) An explicit spec.id still wins for callers that want to pin one.
  const id = existingId
    ? existingId
    : slugifyId(spec.id || baseUrlKey || (port ? `local-${port}` : "local"));
  if (!id) return { ok: false, error: "could not derive id" };

  const now = new Date().toISOString();
  const patch = {
    name:           spec.name           !== undefined ? String(spec.name || unnamedName()) : undefined,
    base_url:       baseUrl,
    api_token:      spec.api_token      !== undefined ? String(spec.api_token || "") : undefined,
    install_source: spec.install_source ?? undefined,
    install_os:     spec.install_os     ?? undefined,
    install_arch:   spec.install_arch   ?? undefined,
    install_path:   spec.install_path   ?? undefined,
    container_name: spec.container_name ?? undefined,
    image:          spec.image          ?? undefined,
  };
  // Drop undefined keys so we never overwrite existing fields with null.
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

  await writeNodes((nodes) => {
    const prev = nodes[id] || {};
    nodes[id] = {
      ...prev,
      ...patch,
      // Upsert by base_url: an EXISTING team keeps its (possibly user-renamed)
      // name — never overwrite the title on re-add, even if the deeplink passes
      // one. Everything else (token, install meta) DOES refresh. Only a brand-
      // new team takes the provided title, falling back to the i18n Unnamed.
      name: prev.name || patch.name || unnamedName(),
      added_at: prev.added_at || now,
      updated_at: now,
    };
    return nodes;
  });
  log.info(`[local-teams] ${existingId ? "upsert" : "add"} ${id} → ${baseUrl} (source=${patch.install_source || "n/a"})`);
  const next = readNodes()[id] || {};
  syncNameToCloud(id).catch(() => {}); // best-effort title sync (desktop→cloud)
  return { ok: true, id, upserted: !!existingId, team: { id, ...next, port } };
}

// Whitelisted partial update — meant for the UI's "rotate token" /
// "rename team" / "change URL" flows. install_* meta updates use this
// too so a reinstall under a different arch can re-record without going
// through the full addTeam path.
const UPDATABLE_FIELDS = new Set([
  "name", "base_url", "api_token",
  "install_source", "install_os", "install_arch",
  "install_path", "container_name", "image",
]);

async function updateTeam(id, patch) {
  if (!id) return { ok: false, error: "id required" };
  if (!patch || typeof patch !== "object") return { ok: false, error: "patch required" };
  const filtered = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!UPDATABLE_FIELDS.has(k)) continue;
    if (v === undefined) continue;
    if (k === "base_url") {
      if (!v) return { ok: false, error: "base_url cannot be empty" };
      try { new URL(String(v)); } catch { return { ok: false, error: "bad base_url" }; }
      filtered[k] = String(v).replace(/\/$/, "");
    } else if (k === "api_token") {
      filtered[k] = String(v || "");
    } else {
      filtered[k] = v;
    }
  }
  if (Object.keys(filtered).length === 0) return { ok: false, error: "no updatable fields in patch" };

  // If base_url is changing, enforce dedupe — refuse to merge two teams.
  if (filtered.base_url) {
    const nextKey = normaliseUrl(filtered.base_url);
    for (const [k, v] of Object.entries(readNodes())) {
      if (k === id) continue;
      if (normaliseUrl(v?.base_url || "") === nextKey) {
        return { ok: false, error: `another team (id=${k}) already uses that base_url` };
      }
    }
  }

  let existed = false;
  const isRename = filtered.name !== undefined;
  await writeNodes((nodes) => {
    if (Object.prototype.hasOwnProperty.call(nodes, id)) {
      existed = true;
      nodes[id] = { ...nodes[id], ...filtered, updated_at: new Date().toISOString() };
      // 改名:只改 name,titleVersion 保持「最后一次从云端看到的」作为 base 不动。
      // syncNameToCloud 带这个 base 去注册;服务端接受后盖 base+1,响应回来再写回本地
      // (服务端权威,w-10032 契约)。冲突(base 落后)则被拒、采用云端名,见 syncNameToCloud。
    }
    return nodes;
  });
  if (!existed) return { ok: false, error: "team not found" };
  log.info(`[local-teams] update ${id} → ${Object.keys(filtered).join(",")}`);
  // Rename → push the new title (with the base titleVersion) to the cloud, and
  // pull down a newer cloud name if there is one (two-way LWW inside syncNameToCloud).
  if (isRename) syncNameToCloud(id).catch(() => {});
  const next = readNodes()[id] || {};
  let port = null;
  try { port = parseInt(new URL(next.base_url || "").port, 10) || null; } catch {}
  return { ok: true, id, team: { id, ...next, port } };
}

async function removeTeam(id) {
  if (!id) return { ok: false, error: "id required" };
  let existed = false;
  await writeNodes((nodes) => {
    if (Object.prototype.hasOwnProperty.call(nodes, id)) {
      existed = true;
      delete nodes[id];
    }
    return nodes;
  });
  log.info(`[local-teams] remove ${id} (existed=${existed})`);
  return { ok: true, removed: existed };
}

// ── upgrade ────────────────────────────────────────────────────────────
//
// Replace the cicy-code daemon backing a local team with the latest
// release. The team's `install_source` decides the path:
//
//   helper-mac-linux / *-native  → download cicy-code-<os>-<arch> from
//     GitHub releases (or COS mirror on fallback), atomic-rename onto
//     `install_path`, pkill the old PID, nohup-relaunch.
//   helper-windows-docker / *-docker → `docker pull <image>`, stop+rm
//     the named container, recreate it with the same port mapping.
//
// We always wait for `/api/health` to come back before returning so the
// renderer can refresh confidently.

const LATEST_BINARY_DIRECT = (os_, arch) =>
  `https://github.com/cicy-ai/cicy-code/releases/latest/download/cicy-code-${os_}-${arch}`;
const LATEST_BINARY_MIRROR = (os_, arch) =>
  `https://cicy-1372193042.cos.ap-shanghai.myqcloud.com/binaries/cicy-code-${os_}-${arch}`;
const LATEST_IMAGE = "cicybot/cicy-code:latest";

function downloadFile(srcUrl, destPath) {
  return new Promise((resolve, reject) => {
    const tryUrl = (urlStr, redirects = 0) => {
      if (redirects > 5) return reject(new Error("too many redirects"));
      let parsed;
      try { parsed = new URL(urlStr); } catch { return reject(new Error("bad_url")); }
      const lib = parsed.protocol === "https:" ? https : http;
      lib.get(parsed, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          return tryUrl(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`download status ${res.statusCode}`));
        }
        const out = fs.createWriteStream(destPath, { mode: 0o755 });
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
      }).on("error", reject);
    };
    tryUrl(srcUrl);
  });
}

function waitForHealth(baseUrl, token, totalMs = 30_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + totalMs;
    const tick = async () => {
      const r = await probeHealth(baseUrl, token);
      if (r.ok) return resolve({ ok: true, version: r.version || null });
      if (Date.now() > deadline) return resolve({ ok: false, error: "health_timeout" });
      setTimeout(tick, 1500);
    };
    tick();
  });
}

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? -1) : 0,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

// Probe a candidate ~/.local/bin/cicy-code symlink for its current version
// without execing the binary (we only need the basename).
function readVersionFromSymlink(symlinkPath) {
  try {
    const target = fs.readlinkSync(symlinkPath);
    const m = path.basename(target).match(/^cicy-code-(\d+\.\d+\.\d+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function upgradeNative(node) {
  if (!node.install_os || !node.install_arch) {
    return { ok: false, error: "missing install_os/install_arch on team config" };
  }

  // Layout: ~/.local/bin/cicy-code is a symlink → cicy-code-<version>. The
  // install_path stored on the team should point at the symlink (the stable
  // entry). Older team rows that stored the versioned binary path still
  // work — we treat install_path's directory as ~/.local/bin and the
  // symlink as cicy-code in that dir.
  const binDir = node.install_path
    ? path.dirname(node.install_path)
    : path.join(require("os").homedir(), ".local", "bin");
  const linkPath = path.join(binDir, "cicy-code");

  // Resolve the manifest's latest version up-front so we can name the
  // downloaded file `cicy-code-<version>` from the start. Fall back to a
  // placeholder name + rename-on-verify if the manifest hop fails.
  let manifestVersion = null;
  try {
    const m = await fetchManifestVersion();
    if (m && /^\d+\.\d+\.\d+$/.test(m)) manifestVersion = m;
  } catch {}
  const placeholderName = manifestVersion ? `cicy-code-${manifestVersion}` : `cicy-code-incoming-${process.pid}-${Date.now()}`;
  const dlPath = path.join(binDir, placeholderName);

  const direct = LATEST_BINARY_DIRECT(node.install_os, node.install_arch);
  const mirror = LATEST_BINARY_MIRROR(node.install_os, node.install_arch);
  let realVersion = manifestVersion;
  try {
    await fsp.mkdir(binDir, { recursive: true });
    try { await downloadFile(direct, dlPath); }
    catch (e) {
      log.info(`[local-teams] direct download failed (${e.message}) — falling back to mirror`);
      await downloadFile(mirror, dlPath);
    }
    await fsp.chmod(dlPath, 0o755);

    // Re-verify version via --version; correct the filename if the mirror
    // served stale bytes.
    try {
      const r = await execAsync(dlPath, ["--version"]);
      const m = (r.stdout || "").match(/(\d+\.\d+\.\d+)/);
      if (m) realVersion = m[1];
    } catch {}
    let finalPath = dlPath;
    if (realVersion && path.basename(dlPath) !== `cicy-code-${realVersion}`) {
      finalPath = path.join(binDir, `cicy-code-${realVersion}`);
      try { await fsp.unlink(finalPath); } catch {}
      await fsp.rename(dlPath, finalPath);
    }

    // Kill the previously running daemon. Match by either the symlink path
    // OR the previously stored install_path (could be a versioned binary).
    if (process.platform !== "win32") {
      await execAsync("pkill", ["-f", linkPath]).catch(() => null);
      if (node.install_path && node.install_path !== linkPath) {
        await execAsync("pkill", ["-f", node.install_path]).catch(() => null);
      }
    }
    await new Promise((r) => setTimeout(r, 500));

    // Atomic-replace the cicy-code symlink. Use a tmp name + rename.
    const tmpLink = `${linkPath}.new-${process.pid}-${Date.now()}`;
    try { await fsp.unlink(tmpLink); } catch {}
    await fsp.symlink(path.basename(finalPath), tmpLink);
    await fsp.rename(tmpLink, linkPath);

    // Relaunch through the symlink so the next upgrade can swap under us.
    const logPath = `${linkPath}.log`;
    const out = fs.openSync(logPath, "a");
    const child = spawn(linkPath, [], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    log.info(`[local-teams] native upgrade relaunched pid=${child.pid} via ${linkPath} → ${path.basename(finalPath)}`);
  } catch (e) {
    try { await fsp.unlink(dlPath); } catch {}
    return { ok: false, error: `native upgrade failed: ${e.message}` };
  }
  const h = await waitForHealth(node.base_url, node.api_token);
  if (h.ok) {
    // Refresh the stored install_path so future upgrades point at the symlink
    // even if older team rows pointed at a versioned binary.
    try {
      await updateTeam(node.id, { install_path: linkPath });
    } catch {}
    return { ok: true, version: h.version || realVersion };
  }
  return { ok: false, error: h.error };
}

// Fetch the latest manifest.json to learn the upcoming version. Falls back
// to null if the manifest is unreachable; upgradeNative still works,
// versioning is recovered after the binary runs --version.
const MANIFEST_DIRECT = "https://github.com/cicy-ai/cicy-code/releases/latest/download/manifest.json";
const MANIFEST_MIRROR = "https://cicy-1372193042.cos.ap-shanghai.myqcloud.com/binaries/manifest.json";
function fetchManifestVersion() {
  return new Promise((resolve) => {
    const tryUrl = (urlStr, redirects = 0, fallbackUrl = null) => {
      if (redirects > 5) return fallbackUrl ? tryUrl(fallbackUrl) : resolve(null);
      let parsed;
      try { parsed = new URL(urlStr); } catch { return resolve(null); }
      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.get({ ...parsed, timeout: 4000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return tryUrl(new URL(res.headers.location, urlStr).toString(), redirects + 1, fallbackUrl);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fallbackUrl ? tryUrl(fallbackUrl) : resolve(null);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; if (body.length > 8192) body = body.slice(0, 8192); });
        res.on("end", () => {
          try { resolve(require("../sidecar/version").parseHealthVersion(body)); }
          catch { resolve(null); }
        });
      });
      req.on("error", () => fallbackUrl ? tryUrl(fallbackUrl) : resolve(null));
      req.on("timeout", () => { req.destroy(); fallbackUrl ? tryUrl(fallbackUrl) : resolve(null); });
    };
    tryUrl(MANIFEST_DIRECT, 0, MANIFEST_MIRROR);
  });
}

async function upgradeDocker(node) {
  const name = node.container_name || "cicy";
  const image = node.image || LATEST_IMAGE;
  const baseUrl = node.base_url || "";
  let port = 8008;
  try { port = parseInt(new URL(baseUrl).port, 10) || 8008; } catch {}
  const pull = await execAsync("docker", ["pull", image]);
  if (!pull.ok) return { ok: false, error: `docker pull failed: ${pull.stderr || pull.code}` };
  await execAsync("docker", ["stop", name]).catch(() => null); // best-effort
  await execAsync("docker", ["rm", name]).catch(() => null);
  const run = await execAsync("docker", [
    "run", "-d",
    "--name", name,
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${port}:8008`,
    "-v", "cicy-home:/home/cicy",
    image,
  ]);
  if (!run.ok) return { ok: false, error: `docker run failed: ${run.stderr || run.code}` };
  const h = await waitForHealth(node.base_url, node.api_token);
  return h.ok ? { ok: true, version: h.version } : { ok: false, error: h.error };
}

async function upgradeTeam(id) {
  if (!id) return { ok: false, error: "id required" };
  const node = readNodes()[id];
  if (!node) return { ok: false, error: "team not found" };
  const src = String(node.install_source || "").toLowerCase();
  const isDocker = src.includes("docker") || (!!node.container_name && !node.install_path);
  const result = isDocker ? await upgradeDocker({ id, ...node }) : await upgradeNative({ id, ...node });
  _cacheUntil = 0;
  if (result.ok) log.info(`[local-teams] upgrade ${id} ok → ${result.version || "unknown"}`);
  else          log.info(`[local-teams] upgrade ${id} failed: ${result.error}`);
  return result;
}

module.exports = { list, openTeam, reloadTeam, closeLocalWindows, addTeam, removeTeam, updateTeam, upgradeTeam, syncAllLocalTeams };
