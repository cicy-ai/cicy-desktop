// Persistent window registry.
//
// Background: every window list in the app (get_windows tool, /ui/windows,
// local-agent-registry) is a LIVE enumeration of BrowserWindow.getAllWindows()
// with NO persistence, and close_window/destroy() drops the window from that
// only source. So a closed window leaves no trace and nothing survives a
// restart.
//
// This module adds a durable structure on disk (~/cicy-ai/db/windows.json):
//   - open  → upsert an entry (status:"open"), deduped by accountIdx + url
//   - close → KEEP the entry, just flip status:"closed" (never delete)
//   - restart → the list reloads; windows that were still open when the app
//     QUIT come back (auto-reopen), windows the user closed stay "closed".
//
// Identity: each entry has an immutable windowKey (uuid). The live
// BrowserWindow.id is ephemeral (reassigned every session) so we keep a
// runtime-only liveId↔windowKey map and never trust the persisted liveId
// across restarts (load() clears it).

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const log = require("electron-log");

const DB_DIR = path.join(os.homedir(), "cicy-ai", "db");
const REGISTRY_PATH = path.join(DB_DIR, "windows.json");

// { windows: { [windowKey]: entry } }
let _cache = null;
// runtime-only: live BrowserWindow.id -> windowKey (rebuilt every process)
const liveIdToKey = new Map();

function ensureDir() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  } catch {}
}

function nowIso() {
  return new Date().toISOString();
}

// Normalize for dedup: drop hash, strip trailing slash, lowercase.
function normalizeUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return String(url).trim().replace(/\/+$/, "").toLowerCase();
  }
}

function load() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
      _cache = raw && typeof raw === "object" && raw.windows ? raw : { windows: {} };
    } else {
      _cache = { windows: {} };
    }
  } catch (e) {
    log.error("[WindowRegistry] load failed:", e.message);
    _cache = { windows: {} };
  }
  // Process restarted → no window is live yet. The persisted liveId is stale;
  // clear it so registerOpen() reuses the existing slot instead of orphaning it.
  for (const k of Object.keys(_cache.windows)) _cache.windows[k].liveId = null;
  return _cache;
}

function persist() {
  ensureDir();
  try {
    const tmp = REGISTRY_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2), "utf8");
    fs.renameSync(tmp, REGISTRY_PATH);
  } catch (e) {
    log.error("[WindowRegistry] persist failed:", e.message);
  }
}

function findEntry(accountIdx, url) {
  const reg = load();
  const norm = normalizeUrl(url);
  for (const key of Object.keys(reg.windows)) {
    const e = reg.windows[key];
    if (e.accountIdx === accountIdx && normalizeUrl(e.url) === norm) return e;
  }
  return null;
}

// A real BrowserWindow was created/opened. Upsert its entry (dedup by
// accountIdx+url) and bind it to the live id. Returns the entry.
function registerOpen({ accountIdx = 0, url = "", title = "", bounds = null, liveId }) {
  const reg = load();
  let entry = findEntry(accountIdx, url);
  // Don't collapse two distinct live windows into one slot: if the matching
  // entry is already bound to a DIFFERENT live window, start a fresh entry.
  if (entry && entry.liveId != null && entry.liveId !== liveId) entry = null;

  if (!entry) {
    const windowKey = crypto.randomUUID();
    entry = {
      windowKey,
      accountIdx,
      url: url || "",
      title: title || "",
      bounds: bounds || null,
      status: "open",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      openedAt: nowIso(),
      closedAt: null,
      liveId: liveId ?? null,
    };
    reg.windows[windowKey] = entry;
  } else {
    entry.status = "open";
    if (url) entry.url = url;
    if (title) entry.title = title;
    if (bounds) entry.bounds = bounds;
    entry.openedAt = nowIso();
    entry.updatedAt = nowIso();
    entry.closedAt = null;
    entry.liveId = liveId ?? entry.liveId;
  }
  if (liveId != null) liveIdToKey.set(liveId, entry.windowKey);
  persist();
  return entry;
}

// Keep a live window's record fresh (url/title/bounds change).
function touch({ liveId, url, title, bounds }) {
  const key = liveIdToKey.get(liveId);
  if (!key) return;
  const reg = load();
  const e = reg.windows[key];
  if (!e) return;
  let changed = false;
  if (url && e.url !== url) {
    e.url = url;
    changed = true;
  }
  if (title && e.title !== title) {
    e.title = title;
    changed = true;
  }
  if (bounds) {
    e.bounds = bounds;
    changed = true;
  }
  if (changed) {
    e.updatedAt = nowIso();
    persist();
  }
}

// User/agent closed a window → keep the record, flip to "closed".
function markClosed(liveId) {
  const key = liveIdToKey.get(liveId);
  if (!key) return;
  const reg = load();
  const e = reg.windows[key];
  if (e) {
    e.status = "closed";
    e.closedAt = nowIso();
    e.updatedAt = nowIso();
    e.liveId = null;
    persist();
  }
  liveIdToKey.delete(liveId);
}

function list() {
  return Object.values(load().windows);
}

function keyForLiveId(liveId) {
  return liveIdToKey.get(liveId) || null;
}

function getByKey(windowKey) {
  return load().windows[windowKey] || null;
}

// Entries that should auto-reopen on startup: status "open" with no live
// binding (i.e. they were open when the app last quit). liveId is cleared by
// load() at process start, so at startup these are exactly the survivors.
function staleOpenEntries() {
  return list().filter((e) => e.status === "open" && e.liveId == null);
}

module.exports = {
  REGISTRY_PATH,
  normalizeUrl,
  registerOpen,
  touch,
  markClosed,
  list,
  keyForLiveId,
  getByKey,
  staleOpenEntries,
  load,
};
