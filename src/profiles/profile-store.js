// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// profile-store.js — the shared "browser profile" standard across both backends.
//
// One profile = one backend (Chrome OR Electron); the two keep their own store
// files and their own cookie engines, but expose an IDENTICAL core schema and
// the same operations (list / proxy / logins). This module is the single source
// of truth for that core — both src/tools/chrome-tools.js and
// src/tools/account-tools.js (and window-utils proxy auto-apply) route through
// it so the field names and semantics never drift.
//
// Stores (unchanged locations):
//   chrome   → ~/cicy-ai/db/chrome.json        keyed "profile_<N>"
//   electron → ~/data/electron/account-<N>.json
//
// Core fields (identical names in BOTH files, added lazily; missing = default):
//   name    : string
//   proxy   : { url, enabled }        ← persisted desired proxy (normalized)
//   logins  : [ { platform, account, addedAt } ]   ← one entry per platform
//   note    : string
//   createdAt / updatedAt : ISO

const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME_JSON = path.join(os.homedir(), "cicy-ai", "db", "chrome.json");
const ELECTRON_DIR = path.join(os.homedir(), "data", "electron");

// ── proxy: the ONE normalizer ────────────────────────────────────────────────
// Accepts every historical encoding and returns the canonical {url, enabled}:
//   ""/null/undefined        → { url:"",  enabled:false }
//   "socks5://…" (string)    → { url:s,   enabled:!!s }   (legacy chrome)
//   { enable, url }          → { url,     enabled:!!enable } (legacy chrome obj)
//   { enabled, url }         → { url,     enabled:!!enabled } (canonical)
function normalizeProxy(raw) {
  if (raw == null || raw === "") return { url: "", enabled: false };
  if (typeof raw === "string") return { url: raw, enabled: !!raw };
  if (typeof raw === "object") {
    const url = typeof raw.url === "string" ? raw.url : "";
    const enabled = ("enabled" in raw ? !!raw.enabled : !!raw.enable) && !!url;
    return { url, enabled };
  }
  return { url: "", enabled: false };
}

// proxyRules(p) → the string for Electron session.setProxy / Chromium --proxy-server
// (empty string = direct/no proxy).
function proxyRules(proxyLike) {
  const p = normalizeProxy(proxyLike);
  return p.enabled && p.url ? p.url : "";
}

// ── logins: shared mutation (one entry per platform, keyed case-insensitively) ─
function upsertLogin(logins, platform, account) {
  const list = Array.isArray(logins) ? logins.slice() : [];
  const key = String(platform || "").trim().toLowerCase();
  if (!key) return list;
  const next = list.filter((l) => String(l.platform || "").toLowerCase() !== key);
  next.push({ platform: key, account: String(account || "").trim(), addedAt: new Date().toISOString() });
  return next;
}

function removeLoginFrom(logins, platform) {
  const list = Array.isArray(logins) ? logins : [];
  const key = String(platform || "").trim().toLowerCase();
  return list.filter((l) => String(l.platform || "").toLowerCase() !== key);
}

// ── rich login record (unified across chrome + electron) ─────────────────────
// One entry per site, keyed by `name` (platform/site name) case-insensitively.
// Legacy thin entries {platform, account, addedAt} are mapped forward so old
// data keeps working: platform→name, account→username, addedAt→loginAt.
const LOGIN_FIELDS = ["url", "name", "username", "email", "mobile", "twofa", "secondEmail", "note", "loginAt", "updatedAt"];

function normalizeLogin(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const s = (v, alt = "") => (typeof v === "string" ? v : alt);
  return {
    url: s(r.url),
    name: s(r.name, s(r.platform)),
    username: s(r.username, s(r.account)),
    email: s(r.email),
    mobile: s(r.mobile),
    twofa: s(r.twofa, s(r.totp)),
    secondEmail: s(r.secondEmail),
    note: s(r.note),
    loginAt: s(r.loginAt, s(r.addedAt)),
    updatedAt: s(r.updatedAt),
  };
}

function loginKey(l) {
  return String((l && (l.name || l.url)) || "").trim().toLowerCase();
}

// Upsert by site key; only NON-EMPTY incoming fields overwrite existing ones
// (so a partial patch never wipes data). Stamps loginAt (first seen) + updatedAt.
function upsertLoginRich(logins, login) {
  const list = (Array.isArray(logins) ? logins : []).map(normalizeLogin);
  const inc = normalizeLogin(login);
  const key = loginKey(inc);
  if (!key) return list;
  const now = new Date().toISOString();
  const i = list.findIndex((l) => loginKey(l) === key);
  if (i >= 0) {
    const merged = { ...list[i] };
    for (const k of LOGIN_FIELDS) if (inc[k]) merged[k] = inc[k];
    merged.loginAt = merged.loginAt || now;
    merged.updatedAt = now;
    list[i] = merged;
  } else {
    inc.loginAt = inc.loginAt || now;
    inc.updatedAt = now;
    list.push(inc);
  }
  return list;
}

function removeLoginRich(logins, key) {
  const k = String(key || "").trim().toLowerCase();
  return (Array.isArray(logins) ? logins : []).map(normalizeLogin).filter((l) => loginKey(l) !== k);
}

// ── ipInfo: per-profile egress IP + geo area + last-probed time ──────────────
function normalizeIpInfo(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    ip: typeof r.ip === "string" ? r.ip : "",
    area: typeof r.area === "string" ? r.area : "",
    probedAt: typeof r.probedAt === "string" ? r.probedAt : "",
  };
}

// ── chrome backend (chrome.json, key profile_<N>) ────────────────────────────
function readChromeConfig() {
  if (!fs.existsSync(CHROME_JSON)) return {};
  try {
    return JSON.parse(fs.readFileSync(CHROME_JSON, "utf-8")) || {};
  } catch {
    return {};
  }
}

function writeChromeConfig(next) {
  fs.mkdirSync(path.dirname(CHROME_JSON), { recursive: true });
  fs.writeFileSync(CHROME_JSON, JSON.stringify(next || {}, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CHROME_JSON, 0o600);
  } catch {}
}

// Identity is recorded in the `accounts` map (accounts.gmail / .google / .github
// → {account,password,totp}) via the account CLI; older code only wrote a bare
// top-level `gmail`. normalizeAccounts coerces the map; resolveGmail prefers the
// accounts map and falls back to the legacy field — so gmail shows whichever way
// it was recorded (this is why panels showed empty: read top-level, wrote accounts).
function normalizeAccounts(raw) {
  const out = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [svc, val] of Object.entries(raw)) {
      if (typeof val === "string") out[svc] = { account: val };
      else if (val && typeof val === "object" && !Array.isArray(val)) out[svc] = val;
    }
  }
  return out;
}
function resolveGmail(accounts, fallback) {
  const a = accounts || {};
  return (
    (a.gmail && a.gmail.account) ||
    (a.google && a.google.account) ||
    (typeof fallback === "string" ? fallback : "") ||
    ""
  );
}

function chromeView(idx, entry) {
  const e = entry && typeof entry === "object" ? entry : {};
  const accounts = normalizeAccounts(e.accounts);
  return {
    id: `chrome-${idx}`,
    backend: "chrome",
    accountIdx: idx,
    name: typeof e.name === "string" && e.name ? e.name : `profile_${idx}`,
    proxy: normalizeProxy(e.proxy),
    logins: (Array.isArray(e.logins) ? e.logins : []).map(normalizeLogin),
    note: typeof e.note === "string" ? e.note : "",
    // chrome-specific extras (read-only passthrough)
    gmail: resolveGmail(accounts, e.gmail),
    accounts,
    port: typeof e.port === "number" ? e.port : 11000 + idx,
    rpaDir: typeof e.rpaDir === "string" ? e.rpaDir : `~/chrome/profile_${idx}`,
    platform: e.platform && typeof e.platform === "object" ? e.platform : {},
    ipInfo: normalizeIpInfo(e.ipInfo),
  };
}

function chromeIndices() {
  const data = readChromeConfig();
  return Object.keys(data)
    .map((k) => (/^profile_(\d+)$/.exec(k) ? Number(/^profile_(\d+)$/.exec(k)[1]) : null))
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b);
}

function mutateChrome(idx, fn) {
  const data = readChromeConfig();
  const key = `profile_${idx}`;
  if (!data[key]) throw new Error(`Missing chrome.json entry: ${key}`);
  data[key] = fn({ ...data[key] }) || data[key];
  data[key].updatedAt = new Date().toISOString();
  writeChromeConfig(data);
  return chromeView(idx, data[key]);
}

// ── electron backend (account-<N>.json) ──────────────────────────────────────
function electronFile(idx) {
  return path.join(ELECTRON_DIR, `account-${idx}.json`);
}

function readAccount(idx) {
  const f = electronFile(idx);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return null;
  }
}

function writeAccount(data) {
  fs.mkdirSync(ELECTRON_DIR, { recursive: true });
  fs.writeFileSync(electronFile(data.accountIdx), JSON.stringify(data, null, 2));
}

function electronView(idx, data) {
  const d = data && typeof data === "object" ? data : { accountIdx: idx };
  const meta = d.metadata && typeof d.metadata === "object" ? d.metadata : {};
  // Electron identities may live on the account file directly (d.accounts) or
  // under metadata (meta.accounts / meta.gmail); resolve from whichever is set.
  const accounts = normalizeAccounts(d.accounts || meta.accounts);
  return {
    id: `electron-${idx}`,
    backend: "electron",
    accountIdx: idx,
    name: typeof meta.name === "string" && meta.name ? meta.name : `electron-${idx}`,
    proxy: normalizeProxy(d.proxy),
    logins: (Array.isArray(d.logins) ? d.logins : []).map(normalizeLogin),
    note: typeof d.note === "string" ? d.note : meta.description || "",
    gmail: resolveGmail(accounts, d.gmail || meta.gmail),
    accounts,
    partition: `persist:sandbox-${idx}`,
    ipInfo: normalizeIpInfo(d.ipInfo),
  };
}

function electronIndices() {
  if (!fs.existsSync(ELECTRON_DIR)) return [];
  return fs
    .readdirSync(ELECTRON_DIR)
    .map((f) => (/^account-(\d+)\.json$/.exec(f) ? Number(/^account-(\d+)\.json$/.exec(f)[1]) : null))
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b);
}

function mutateElectron(idx, fn) {
  let data = readAccount(idx);
  if (!data) {
    data = { accountIdx: idx, createdAt: new Date().toISOString(), windows: [], metadata: {} };
  }
  data = fn(data) || data;
  data.updatedAt = new Date().toISOString();
  writeAccount(data);
  return electronView(idx, data);
}

// ── unified surface (backend = "chrome" | "electron") ────────────────────────
function listProfiles(backend) {
  if (backend === "chrome") return chromeIndices().map((i) => chromeView(i, readChromeConfig()[`profile_${i}`]));
  if (backend === "electron") return electronIndices().map((i) => electronView(i, readAccount(i)));
  throw new Error(`Unknown backend: ${backend}`);
}

function getProfile(backend, idx) {
  if (backend === "chrome") {
    const e = readChromeConfig()[`profile_${idx}`];
    if (!e) return null;
    return chromeView(idx, e);
  }
  if (backend === "electron") {
    const d = readAccount(idx);
    return d ? electronView(idx, d) : null;
  }
  throw new Error(`Unknown backend: ${backend}`);
}

// setProxy persists the desired proxy (canonical {url, enabled}) to the store.
// Empty/falsey url clears it. Returns the updated unified view.
function setProxy(backend, idx, url) {
  const proxy = normalizeProxy(url);
  if (backend === "chrome") return mutateChrome(idx, (e) => ({ ...e, proxy }));
  if (backend === "electron") return mutateElectron(idx, (d) => ({ ...d, proxy }));
  throw new Error(`Unknown backend: ${backend}`);
}

// setNote — free-form per-profile note (both backends).
function setNote(backend, idx, note) {
  const text = typeof note === "string" ? note.trim() : "";
  if (backend === "chrome") return mutateChrome(idx, (e) => ({ ...e, note: text }));
  if (backend === "electron") return mutateElectron(idx, (d) => ({ ...d, note: text }));
  throw new Error(`Unknown backend: ${backend}`);
}

// setLogin — upsert a rich login record (any subset of LOGIN_FIELDS). Keyed by
// `name` (site name). Works identically for both backends.
function setLogin(backend, idx, login) {
  if (backend === "chrome") return mutateChrome(idx, (e) => ({ ...e, logins: upsertLoginRich(e.logins, login) }));
  if (backend === "electron") return mutateElectron(idx, (d) => ({ ...d, logins: upsertLoginRich(d.logins, login) }));
  throw new Error(`Unknown backend: ${backend}`);
}

// addLogin — back-compat thin form (platform/account); delegates to setLogin.
function addLogin(backend, idx, platform, account) {
  return setLogin(backend, idx, { name: platform, username: account });
}

// setIpInfo — persist a freshly probed egress IP + area, stamping probedAt=now.
function setIpInfo(backend, idx, info) {
  const ipInfo = { ...normalizeIpInfo(info), probedAt: new Date().toISOString() };
  if (backend === "chrome") return mutateChrome(idx, (e) => ({ ...e, ipInfo }));
  if (backend === "electron") return mutateElectron(idx, (d) => ({ ...d, ipInfo }));
  throw new Error(`Unknown backend: ${backend}`);
}

function removeLogin(backend, idx, nameOrUrl) {
  if (backend === "chrome") return mutateChrome(idx, (e) => ({ ...e, logins: removeLoginRich(e.logins, nameOrUrl) }));
  if (backend === "electron") return mutateElectron(idx, (d) => ({ ...d, logins: removeLoginRich(d.logins, nameOrUrl) }));
  throw new Error(`Unknown backend: ${backend}`);
}

function listLogins(backend, idx) {
  const p = getProfile(backend, idx);
  return p ? p.logins : [];
}

module.exports = {
  CHROME_JSON,
  ELECTRON_DIR,
  normalizeProxy,
  proxyRules,
  listProfiles,
  getProfile,
  setProxy,
  setNote,
  setLogin,
  addLogin,
  removeLogin,
  listLogins,
  normalizeLogin,
  LOGIN_FIELDS,
  setIpInfo,
  normalizeIpInfo,
};
