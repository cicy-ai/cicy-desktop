// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// telegram-identity.js — read "who is logged in" out of a Telegram Web (K)
// session so the matrix list can show each profile's @username.
//
// Telegram Web K keeps the current account id in localStorage `user_auth`
// ({id, dcID, date}) and caches user records in IndexedDB `tweb-account-<n>`
// (store `users`, keyed by the stringified user id). The self record carries
// username / first_name / last_name / phone. Nothing here touches auth keys.

const TELEGRAM_HOST_RE = /(^|\.)web\.telegram\.org$/i;

function isTelegramUrl(url) {
  try { return TELEGRAM_HOST_RE.test(new URL(String(url || "")).hostname); } catch (e) { return false; }
}

// Runs inside the (sandboxed) Telegram page via executeJavaScript. Returns a
// plain object or null; never throws (the caller treats any failure as "unknown").
const TELEGRAM_IDENTITY_SCRIPT = `(async () => {
  try {
    const auth = JSON.parse(localStorage.getItem("user_auth") || "null");
    const id = auth && (auth.id || auth.user_id);
    if (!id) return null;
    const key = String(id);
    const names = (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [])
      .filter((n) => /^tweb-account-\\d+$/.test(String(n || "")));
    if (!names.length) names.push("tweb-account-1");
    for (const name of names) {
      let db = null;
      try {
        db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked")); });
        if (!db.objectStoreNames.contains("users")) { db.close(); continue; }
        const user = await new Promise((res) => { const tx = db.transaction("users", "readonly"); const r = tx.objectStore("users").get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
        db.close();
        if (user && String(user.id) === key) {
          return { id: key, username: user.username || "", firstName: user.first_name || "", lastName: user.last_name || "", phone: user.phone || "" };
        }
      } catch (e) { try { db && db.close(); } catch (_) {} }
    }
    return { id: key, username: "", firstName: "", lastName: "", phone: "" };
  } catch (e) { return null; }
})()`;

function normalizeTelegramIdentity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const id = s(raw.id);
  if (!id) return null;
  const username = s(raw.username).replace(/^@/, "");
  // accepts the raw page shape (firstName/lastName) or an already-normalized one (displayName)
  const displayName = s(raw.displayName) || [s(raw.firstName), s(raw.lastName)].filter(Boolean).join(" ");
  return { id, username, displayName, phone: s(raw.phone) };
}

// Profile-store login record for this identity (keyed by name "telegram").
function telegramLoginRecord(identity) {
  const it = normalizeTelegramIdentity(identity);
  if (!it) return null;
  return {
    url: "https://web.telegram.org",
    name: "telegram",
    username: it.username,
    mobile: it.phone,
    note: it.displayName,
  };
}

// Reverse: identity view from a stored profile (for list rendering).
function telegramIdentityFromProfile(profile) {
  const logins = profile && Array.isArray(profile.logins) ? profile.logins : [];
  const l = logins.find((x) => String((x && x.name) || "").toLowerCase() === "telegram");
  if (!l) return null;
  return { username: String(l.username || ""), displayName: String(l.note || ""), phone: String(l.mobile || "") };
}

module.exports = { isTelegramUrl, TELEGRAM_IDENTITY_SCRIPT, normalizeTelegramIdentity, telegramLoginRecord, telegramIdentityFromProfile };
