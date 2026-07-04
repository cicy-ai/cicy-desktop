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
const { BrowserWindow, nativeImage } = require("electron");
// i18n for the default team name ("Unnamed"/"未命名"/…). Resolved at create
// time from the app locale; falls back to "Unnamed" if i18n isn't ready.
let __t, __i18nMod;
try { __i18nMod = require("../i18n"); __t = __i18nMod.t; } catch { __t = null; }
const unnamedName = () => { try { return (__t && __t("localTeams.unnamed")) || "Unnamed"; } catch { return "Unnamed"; } };

// 默认团队名(「本地团队」/「Local Team」/…)是注册时按当时语言写进 teams.json 的快照。
// 切换语言后它不会变 → 显示时若发现存的就是任一语言的默认名,改用**当前语言**的默认名;
// 用户改过的真实名字不匹配任何默认名 → 原样保留。
function localizedTeamName(stored) {
  try {
    if (!__i18nMod || !__i18nMod.i18next) return stored;
    const cur = __t("localTeams.defaultName");
    if (!stored) return cur;
    const isDefault = (__i18nMod.SUPPORTED || []).some((l) => __i18nMod.i18next.t("localTeams.defaultName", { lng: l }) === stored);
    return isDefault ? cur : stored;
  } catch { return stored; }
}
const log = require("electron-log");

// global.json is now only read for the local sidecar's api_token (auto-fill).
// The TEAM LIST lives in its own file: ~/cicy-ai/db/teams.json — decoupled from
// global.json (which cicy-code + the helper self-register into, which used to
// leak "Unnamed" ghosts into the team list). Shape: a flat { "<id>": {node} } map.
const GLOBAL_JSON = path.join(os.homedir(), "cicy-ai", "global.json");
const TEAMS_JSON = path.join(os.homedir(), "cicy-ai", "db", "teams.json");
// 通用头像映射 { <id>: dataUrl } —— 按 id 存,本地/Docker/云端团队通用(云端团队不在
// teams.json,只能用独立映射)。id 即各卡片用的 team id(本地 slug / 云端 cloud id)。
const AVATARS_JSON = path.join(os.homedir(), "cicy-ai", "db", "team-avatars.json");
function readAvatars() {
  try { const o = JSON.parse(fs.readFileSync(AVATARS_JSON, "utf8")); return (o && typeof o === "object") ? o : {}; } catch { return {}; }
}
async function writeAvatars(map) {
  const tmp = `${AVATARS_JSON}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.mkdir(path.dirname(AVATARS_JSON), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, AVATARS_JSON);
}
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
    // 探活不用 token: 死活完全由裸 TCP 端口判定。/api/health 仅用来补版本号,**不带 token**
    // —— 本地团队真正用的 token 是 ~/cicy-ai/global.json 的 api_token,在 openTeam 时实时拿;若这里
    // 带上 teams.json 里可能已陈旧的快照,旧 token → 401 → 会把活着的守护进程误标成 auth_error。
    // 端口开着就是 running,health 401/超时都不降级。
    const health = await probeHealth(baseUrl, "");
    return { status: "running", version: health.version || null, error: null };
  }
  const health = await probeHealth(baseUrl, token);
  return { status: classify(health), version: health.version || null, error: health.error || null };
}

async function list({ refresh = false } = {}) {
  if (!refresh && _cache && Date.now() < _cacheUntil) return _cache;
  const nodes = readNodes();
  const avatars = readAvatars();
  const slugs = Object.keys(nodes);
  const teams = await Promise.all(slugs.map(async (slug) => {
    const node = nodes[slug] || {};
    const baseUrl = node.base_url || "";
    let port = null;
    try { port = parseInt(new URL(baseUrl).port, 10) || null; } catch {}
    const live = await probeLiveness(baseUrl, node.api_token);
    return {
      id: slug,
      name: localizedTeamName(node.name) || slug,
      base_url: baseUrl,
      api_token: node.api_token || "",
      avatar: avatars[slug] || node.avatar || "",   // 自定义团队头像(data URL,≤64px);空=首字母兜底
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
async function openTeam(id, opts = {}) {
  const node = readNodes()[id];
  if (!node) return { ok: false, error: "team not found" };
  const baseUrl = (node.base_url || "").replace(/\/$/, "");
  if (!baseUrl) return { ok: false, error: "no base_url" };
  // ?token= 实时拿: 本地团队的 token 就是 ~/cicy-ai/global.json 的 api_token(和 cicy-code
  // 共用同一份)—— 打开时**实时读 global.json**,cicy-code 轮换 token 也立刻跟得上,绝不吃 teams.json
  // 里可能已陈旧的快照(陈旧 → ?token= 旧值 → :8008 拒 → 卡登录/白屏)。opts.token(如 :8008 容器
  // 自己实时拿的)优先级最高;非本地团队仍用存的 node.api_token。
  let isLocalUrl = false;
  try { const h = new URL(baseUrl).hostname; isLocalUrl = h === "127.0.0.1" || h === "localhost" || h === "::1"; } catch {}
  const token = (opts && opts.token)
    || (isLocalUrl ? (readGlobal()?.api_token || node.api_token || "") : (node.api_token || ""));
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
  // loads a blank page the user has to manually reload (bug). Start it if
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
    // team=true + avatar:这是个团队 tab → icon 用团队头像、禁用页面 favicon(见 tab-shell)。
    const r = await tabBrowser.openTab(0, url, { trusted: true, systemOpen: true, title: localizedTeamName(node.name) || id, team: true, avatar: readAvatars()[id] || "", colorKey: id });
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
function reloadTeam(id, opts = {}) {
  const { ignoreCache = false } = opts || {};
  const node = readNodes()[id];
  if (!node) return { ok: false, error: "team not found" };
  const baseUrl = (node.base_url || "").replace(/\/$/, "");
  if (!baseUrl) return { ok: false, error: "no base_url" };
  const token = node.api_token || "";
  const url = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : baseUrl;
  // 本地团队都开在 **profile 0** 的标签窗口里(BrowserView tab),不是顶层
  // BrowserWindow。所以先走 account-0 的标签管理器按 URL 找那个标签 IN-PLACE 刷
  // (ignoreCache 绕缓存,cicy-code 升级后才能拿到新资源而非缓存的旧 index.html)。
  // 找不到 = 标签没开 → no_open_window,绝不偷偷开新标签。
  // (旧版 reloadTeam 在顶层 BrowserWindow 里找,永远找不到 BrowserView 标签 →
  //  永远 no_open_window:刷新窗口从没真刷、更新后自动刷静默失效,都是这个 bug。)
  try {
    const r = require("../tools/tab-browser-tools").reloadTabIfOpen(0, url, { ignoreCache });
    if (r && r.ok) { log.info(`[local-teams] reload ${id} → tab in win.id=${r.winId} ignoreCache=${ignoreCache}`); return r; }
  } catch (e) { log.warn(`[local-teams] reload ${id} tab path failed: ${e.message}`); }
  // 兜底:极少数情况下 openTeam 退化成真窗口(openTab 抛错时),按老方式找顶层窗口。
  const targetKey = stripVolatile(url);
  const win = BrowserWindow.getAllWindows().find((w) => {
    if (!w || w.isDestroyed()) return false;
    try { return stripVolatile(w.webContents.getURL()) === targetKey; }
    catch { return false; }
  });
  if (!win) return { ok: false, error: "no_open_window" };
  try {
    if (ignoreCache) win.webContents.reloadIgnoringCache();
    else win.webContents.reload();
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    log.info(`[local-teams] reload ${id} → win.id=${win.id} ignoreCache=${ignoreCache}`);
    return { ok: true, windowId: win.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Close any open window served by the local sidecar (origin
// http://127.0.0.1:<port> or http://localhost:<port>). Called when the sidecar
// is STOPPED so a now-dead :8008 team window doesn't linger showing a broken
// page (bug report: stop 后应关掉 localhost 的 window).
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
    let host = p.hostname.toLowerCase();
    // 回环地址归一:localhost / ::1 与 127.0.0.1 是同一个端点,去重时算同一个
    // (否则「自定义」加 localhost:8008 不会被识别成已有的 127.0.0.1:8008 本地团队)。
    if (host === "localhost" || host === "::1" || host === "[::1]") host = "127.0.0.1";
    return `${host}:${port}`;
  } catch { return ""; }
}

// Sync THIS device's local team title to the cloud (desktop→cloud, one-way;
// + w-10032 spec). Best-effort: a cloud failure NEVER blocks the local
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
    if (!node) return;
    // 自定义(远程 URL)团队:同步 {title, host_url} 到云端(kind=custom,复用 /api/teams)。
    // docker 节点是 localhost(local-origin),不会进这;custom = 非 local-origin 的远程节点。
    if (node.base_url && !isLocalOrigin(node.base_url)) {
      const reg = await cc.registerCustomTeam({ teamId: node.cloud_team_id || null, title: node.name || "", hostUrl: node.base_url });
      if (reg && reg.ok && reg.teamId && reg.teamId !== node.cloud_team_id) {
        await writeNodes((nodes) => { if (nodes[id]) nodes[id].cloud_team_id = reg.teamId; return nodes; });
        log.info(`[local-teams] custom team synced ${id} → cloud teamId=${reg.teamId}`);
      }
      return;
    }
    if (!isLocalOrigin(node.base_url || "")) return;
    // Docker 节点有自己独立的云端 team(POST /api/teams,sidecar ensureDockerTeam 管),
    // 绝不走这里的 device-register —— 否则会按本机 deviceId 复用回 8008 那个 team(40),
    // cloud_team_id 被覆盖、又和 8008 串名。按 is_docker 标记 OR 端口(docker app port)
    // 跳过(端口判断不依赖标记的写入时机,更稳)。
    {
      // 端口判定仅在 Windows 生效:Windows 没有 native(8008 即 docker);mac/linux 的
      // native 就是 8008,绝不能按端口把 native 误判成 docker(否则跳过 device-register)。
      const DOCKER_PORT = String(process.env.CICY_DOCKER_APP_PORT || 8008);
      let isDockerNode = !!node.is_docker;
      try { if (process.platform === "win32" && new URL(node.base_url).port === DOCKER_PORT) isDockerNode = true; } catch {}
      if (isDockerNode) return;
    }
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
    // it (full provider items + CLI routing, spec) into this machine's
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

// 从云端拉取 kind=custom 团队,本地没有的按 host_url materialize 一张卡片。**只增**(这版
// 删除不同步)。addTeam 内部按 base_url dedup,已有的不会重复建。best-effort。
async function pullCustomTeams() {
  let cc;
  try { cc = require("../cloud/cloud-client"); } catch { return; }
  try {
    if (!cc.loginToken || !cc.loginToken()) return;
    const list = await cc.listTeams();
    if (!list || !list.ok || !Array.isArray(list.teams)) return;
    const nodes = readNodes();
    const stripUrl = (u) => { let s = String(u || "").trim(); try { const x = new URL(s); x.search = ""; x.hash = ""; s = x.toString(); } catch {} return normaliseUrl(s.replace(/\/$/, "")); };
    const have = new Set(Object.values(nodes).map((n) => stripUrl(n?.base_url)).filter(Boolean));
    // cloud_team_id 用 String 归一比较 —— 云端返回 number、本地可能存成 number/string,不归一
    // 会漏判(dedup 失效 → 又 materialize 一次,可能按派生 id 覆盖掉用户刚改过 URL 的那张卡)。
    const haveCloudIds = new Set(Object.values(nodes).map((n) => (n?.cloud_team_id != null ? String(n.cloud_team_id) : null)).filter(Boolean));
    let n = 0;
    for (const t of list.teams) {
      if (t.kind !== "custom") continue;
      const host = String(t.host_url || t.hostUrl || "").trim();
      if (!host) continue;
      const tid = t.teamId || t.id || null;
      if (have.has(stripUrl(host)) || (tid != null && haveCloudIds.has(String(tid)))) continue; // 本地已有
      try {
        const r = await addTeam({ base_url: host, name: t.title || t.name || host, cloud_team_id: tid });
        if (r && r.ok) { n++; log.info(`[local-teams] materialized custom team ${host} (cloud teamId=${tid})`); }
      } catch (e) { log.warn(`[local-teams] materialize custom ${host} failed: ${e.message}`); }
    }
    if (n) log.info(`[local-teams] pulled ${n} custom team(s) from cloud`);
  } catch (e) { log.warn(`[local-teams] pullCustomTeams failed: ${e.message}`); }
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
    // 所有带 base_url 的节点都过一遍 —— syncNameToCloud 内部按类型分流:local-origin →
    // registerTeam,custom(远程 URL)→ registerCustomTeam,docker → 跳过。
    const ids = Object.keys(nodes).filter((id) => !!(nodes[id]?.base_url));
    for (const id of ids) {
      try { await syncNameToCloud(id); } catch {}
    }
    if (ids.length) log.info(`[local-teams] startup cloud-sync of ${ids.length} team(s)`);
    try { await pullCustomTeams(); } catch {}
  } catch (e) { log.warn(`[local-teams] startup cloud-sync failed: ${e.message}`); }
}

async function addTeam(spec) {
  if (!spec || typeof spec !== "object") return { ok: false, error: "spec required" };
  const baseUrlRaw = String(spec.base_url || "").trim();
  if (!baseUrlRaw) return { ok: false, error: "base_url required" };
  try { new URL(baseUrlRaw); } catch { return { ok: false, error: "bad base_url" }; }
  // **本地团队**(localhost/127.0.0.1/::1)才把 base_url 剥成干净 origin —— 它 token 从
  // global.json 实时读,URL 里存 ?token= 快照会陈旧、打开还会双拼。**自定义远程团队相反**:
  // token 只在用户给的 URL 里,原样保留、绝不剥 query/hash(主人:不要动原始的 url),否则
  // token 丢、节点打不开。isLocalUrl 在这里算一次,下面复用。
  let isLocalUrl = false;
  try { const h = new URL(baseUrlRaw).hostname; isLocalUrl = h === "127.0.0.1" || h === "localhost" || h === "::1"; } catch {}
  let baseUrl = baseUrlRaw.replace(/\/$/, "");
  if (isLocalUrl) { try { const u = new URL(baseUrl); u.search = ""; u.hash = ""; baseUrl = u.toString().replace(/\/$/, ""); } catch {} }
  const baseUrlKey = normaliseUrl(baseUrl);
  let port = null;
  try { port = parseInt(new URL(baseUrl).port, 10) || null; } catch {}

  // 本地团队的 token **不存进 teams.json**: localhost/127.0.0.1/::1 的 cicy-code 与
  // cicy-desktop 共用同一份 ~/cicy-ai/global.json,openTeam 打开时**实时读 global.json**(token
  // 轮换即时跟上)。存一份快照只会陈旧 → ?token= 旧值 → :8008 拒 → 卡登录。所以本地一律存 ""
  // (与 :8008 docker 的 skipTokenAutofill 同理),不再自动回填。isLocalUrl 已在上面算过。

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
  // failIfExists(自定义 modal 用):地址已存在就**拒绝**,不静默 upsert(否则用户从「自定义」
  // 加一个已有地址会悄悄合并/重复)。deeplink/安装器不传这个 flag,保持原 upsert 行为。
  if (spec.failIfExists && existingId) return { ok: false, error: "exists", id: existingId };

  // Derive the id from the host:port key so it CAN'T collide: two different
  // nodes never share an id (different host:port → different slug), and the
  // same node always hits existingId above. (Was spec.name || local-<port>,
  // which made two hosts on the same port — or same name — overwrite each
  // other.) An explicit spec.id still wins for callers that want to pin one.
  const id = existingId
    ? existingId
    : slugifyId(spec.id || baseUrlKey || (port ? `local-${port}` : "local"));
  if (!id) return { ok: false, error: "could not derive id" };

  // The Docker app node MUST self-identify as is_docker AT CREATION — atomically,
  // in the SAME writeNodes as the node itself — not in a later updateTeam. Reason:
  // addTeam fires syncNameToCloud(id) below (fire-and-forget). If is_docker isn't
  // already on the node, that first sync sees a plain local team, device-registers
  // it, and the cloud hands back THIS DEVICE's shared team (= the 8008 team) — so
  // :8008 and :8008 end up on one cloud_team_id and renaming one renames both
  // ("串名"). Marking is_docker here (explicit spec OR by the docker app port, which
  // doesn't depend on the caller setting a flag) closes that window for ALL creation
  // paths (sidecar registerAppTeam, a cloud deeplink, a manual add). cloud_team_id
  // (the node's OWN independent team) is written the same atomic way when known.
  // 端口判定仅 Windows 生效(见上:mac/linux native 也是 8008,不能按端口误判)。
  const DOCKER_PORT = String(process.env.CICY_DOCKER_APP_PORT || 8008);
  const isDockerNode = !!spec.is_docker || (process.platform === "win32" && port != null && String(port) === DOCKER_PORT);

  const now = new Date().toISOString();
  const patch = {
    name:           spec.name           !== undefined ? String(spec.name || unnamedName()) : undefined,
    base_url:       baseUrl,
    // 本地团队 / Docker :8008 → 一律存 ""(token 实时从 global.json / 容器读,绝不存快照)。
    api_token:      (spec.skipTokenAutofill || isLocalUrl) ? "" : (spec.api_token !== undefined ? String(spec.api_token || "") : undefined),
    install_source: spec.install_source ?? undefined,
    install_os:     spec.install_os     ?? undefined,
    install_arch:   spec.install_arch   ?? undefined,
    install_path:   spec.install_path   ?? undefined,
    container_name: spec.container_name ?? undefined,
    image:          spec.image          ?? undefined,
    // is_docker: only ever set TRUE (never flip an existing node to false).
    is_docker:      isDockerNode ? true : undefined,
    // cloud_team_id: set only when the caller passes a real id — a falsy value is
    // dropped so we never clobber an already-correct independent team with null.
    cloud_team_id:  spec.cloud_team_id ? spec.cloud_team_id : undefined,
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
  "cloud_team_id", "is_docker", // Docker 独立 team:cloud_team_id 给账单/改名,is_docker 让 syncNameToCloud 跳过
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
      // 和 addTeam 一致:本地团队剥成干净 origin;自定义远程团队**原样保留**(含 ?token=,
      // 主人:不要动原始的 url)——token 只在 URL 里,剥了就打不开。
      let bu = String(v).replace(/\/$/, "");
      let localU = false;
      try { const h = new URL(bu).hostname; localU = h === "127.0.0.1" || h === "localhost" || h === "::1"; } catch {}
      if (localU) { try { const u = new URL(bu); u.search = ""; u.hash = ""; bu = u.toString().replace(/\/$/, ""); } catch {} }
      filtered[k] = bu;
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
  // 改名 或 改 base_url(自定义团队换址)都要同步到云端:改名走 title,换址走 host_url
  // (custom 分支 PATCH host_url)。否则云端留着旧 URL,下次 pull 又把旧地址拉回来 = 改了白改。
  if (isRename || filtered.base_url) syncNameToCloud(id).catch(() => {});
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

// Set (or clear) a team's avatar. The uploaded image is resized to ≤64px and
// stored as a data URL on the node — small enough for teams.json, and usable
// directly as <img src> in the team card AND the tab strip icon (no file://).
async function setAvatar(id, dataUrl) {
  if (!id) return { ok: false, error: "no id" };
  let stored = "";
  if (dataUrl && /^data:image\//.test(dataUrl)) {
    try {
      let img = nativeImage.createFromDataURL(dataUrl);
      if (!img.isEmpty()) {
        const { width } = img.getSize();
        if (width > 64) img = img.resize({ width: 64, height: 64, quality: "good" });
        stored = img.toDataURL();
      }
    } catch (e) { log.warn(`[local-teams] setAvatar resize failed: ${e.message}`); }
  }
  const map = readAvatars();
  if (stored) map[id] = stored; else delete map[id];
  await writeAvatars(map);
  _cacheUntil = 0;
  return { ok: true, avatar: stored };
}

// Whole avatar map { id: dataUrl } — renderer fetches once and passes the right
// avatar to EVERY card (local / Docker / cloud), all keyed by their team id.
function getAvatars() { return readAvatars(); }

// Look up a team's avatar by URL (origin+pathname match against teams.json) — the
// tab strip uses this to icon a LOCAL/Docker team tab. Cloud team tabs pass the
// avatar through tabs.open() instead (they're not in teams.json). "" if none.
function avatarForUrl(url) {
  try {
    const key = stripVolatile(url);
    const nodes = readNodes();
    const avatars = readAvatars();
    for (const id of Object.keys(nodes)) {
      const b = nodes[id].base_url || "";
      if (b && (stripVolatile(b) === key || key.startsWith(stripVolatile(b)))) return avatars[id] || "";
    }
  } catch {}
  return "";
}

module.exports = { list, openTeam, reloadTeam, closeLocalWindows, addTeam, removeTeam, updateTeam, upgradeTeam, syncAllLocalTeams, setAvatar, getAvatars, avatarForUrl };
