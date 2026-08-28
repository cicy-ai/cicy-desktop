// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// facebook-identity.js — read "who is logged in" out of a Facebook web session so
// the Facebook 矩阵 list can show each profile's account name.
//
// Facebook embeds the current account in the initial page payload
// (CurrentUserInitialData: {"ACCOUNT_ID","USER_ID","NAME","SHORT_NAME"}) and the
// numeric id in the `c_user` cookie. We read only id + display name; nothing
// here touches session cookies' values beyond the public user id.

const FACEBOOK_HOST_RE = /(^|\.)facebook\.com$/i;

function isFacebookUrl(url) {
  try { return FACEBOOK_HOST_RE.test(new URL(String(url || "")).hostname); } catch (e) { return false; }
}

const FACEBOOK_IDENTITY_SCRIPT = `(() => {
  try {
    const m = document.cookie.match(/(?:^|;\\s*)c_user=(\\d+)/);
    const id = m ? m[1] : "";
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const name = (html.match(/"NAME":"((?:[^"\\\\]|\\\\.)*)"/) || [])[1] || "";
    const shortName = (html.match(/"SHORT_NAME":"((?:[^"\\\\]|\\\\.)*)"/) || [])[1] || "";
    const uid = id || (html.match(/"USER_ID":"(\\d+)"/) || [])[1] || "";
    if (!uid || uid === "0") return null;
    const dec = (s) => { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } };
    return { id: uid, displayName: dec(name), shortName: dec(shortName) };
  } catch (e) { return null; }
})()`;

function normalizeFacebookIdentity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const id = s(raw.id);
  if (!id || id === "0") return null;
  return { id, username: s(raw.username), displayName: s(raw.displayName) || s(raw.shortName), phone: "" };
}

// Profile-store login record (keyed by name "facebook").
function facebookLoginRecord(identity) {
  const it = normalizeFacebookIdentity(identity);
  if (!it) return null;
  return { url: "https://www.facebook.com", name: "facebook", username: it.id, mobile: "", note: it.displayName };
}

// Reverse: identity view from a stored profile (for list rendering).
function facebookIdentityFromProfile(profile) {
  const logins = profile && Array.isArray(profile.logins) ? profile.logins : [];
  const l = logins.find((x) => String((x && x.name) || "").toLowerCase() === "facebook");
  if (!l) return null;
  return { id: String(l.username || ""), username: "", displayName: String(l.note || ""), phone: "" };
}

module.exports = { isFacebookUrl, FACEBOOK_IDENTITY_SCRIPT, normalizeFacebookIdentity, facebookLoginRecord, facebookIdentityFromProfile };
