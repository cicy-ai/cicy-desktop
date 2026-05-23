// File-backed BackendRegistry. Stores user's known cicy-code backends in
// <userData>/backends.json. A pinned `local` entry is upserted on every load
// so it cannot be accidentally deleted from the launcher UI.
//
// See docs/backend-selector-design.md for the full data model.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

const LOCAL_ID = "local";
const SCHEMA_VERSION = 1;

function storePath() {
  return path.join(app.getPath("userData"), "backends.json");
}

function load() {
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { version: SCHEMA_VERSION, backends: [] };
    if (!Array.isArray(data.backends)) data.backends = [];
    return data;
  } catch {
    return { version: SCHEMA_VERSION, backends: [] };
  }
}

function save(data) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function ensureLocal(data) {
  const i = data.backends.findIndex(b => b.id === LOCAL_ID);
  const prev = i >= 0 ? data.backends[i] : null;
  const entry = {
    id: LOCAL_ID,
    name: "Local (bundled)",
    kind: "local",
    url: "",
    addedAt: prev?.addedAt || new Date().toISOString(),
    lastUsedAt: prev?.lastUsedAt,
  };
  if (i >= 0) {
    data.backends[i] = entry;
  } else {
    data.backends.unshift(entry);
  }
}

function list() {
  const data = load();
  ensureLocal(data);
  save(data);
  return data.backends;
}

// Best-effort: invalidate window-utils trusted-origin cache so newly added
// backends are eligible for electronRPC auto-inject on next dom-ready
// without restarting the app. Wrapped in try so this module can be loaded
// during tests where window-utils isn't available.
function invalidateTrustCache() {
  try { require("../utils/window-utils").refreshTrustedOrigins(); } catch {}
}

function add({ name, url, token }) {
  if (!url || typeof url !== "string") throw new Error("url is required");
  const data = load();
  const b = {
    id: crypto.randomUUID(),
    name: String(name || "Unnamed").trim() || "Unnamed",
    kind: "manual",
    url: String(url).trim(),
    token: token ? String(token).trim() : undefined,
    addedAt: new Date().toISOString(),
  };
  data.backends.push(b);
  save(data);
  invalidateTrustCache();
  return b;
}

function remove(id) {
  if (id === LOCAL_ID) return false;
  const data = load();
  const before = data.backends.length;
  data.backends = data.backends.filter(b => b.id !== id);
  if (data.backends.length === before) return false;
  save(data);
  invalidateTrustCache();
  return true;
}

// Update a cloud backend's name/url/token. Returns the updated entry or null.
// `local` is read-only — refuse silently. Token "" or null clears it.
function update({ id, name, url, token }) {
  if (!id || id === LOCAL_ID) return null;
  const data = load();
  const i = data.backends.findIndex(b => b.id === id);
  if (i < 0) return null;
  const prev = data.backends[i];
  const next = {
    ...prev,
    name: name !== undefined ? (String(name).trim() || prev.name) : prev.name,
    url:  url  !== undefined ? String(url).trim() : prev.url,
    token: token === "" || token === null ? undefined : (token !== undefined ? String(token).trim() : prev.token),
    updatedAt: new Date().toISOString(),
  };
  data.backends[i] = next;
  save(data);
  invalidateTrustCache();
  return next;
}

function get(id) {
  const data = load();
  ensureLocal(data);
  return data.backends.find(b => b.id === id);
}

function markUsed(id) {
  const data = load();
  const b = data.backends.find(x => x.id === id);
  if (!b) return;
  b.lastUsedAt = new Date().toISOString();
  save(data);
}

module.exports = { LOCAL_ID, list, add, remove, update, get, markUsed, storePath };
