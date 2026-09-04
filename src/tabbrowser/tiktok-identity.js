// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// tiktok-identity.js — read "who is logged in" out of a TikTok web session so
// the TikTok 矩阵 list can show each profile's account name.
//
// TikTok ships the logged-in user in a JSON blob the page bootstraps from:
// `__UNIVERSAL_DATA_FOR_REHYDRATION__` (current builds) or the older
// `SIGI_STATE`, both under webapp.user-detail / AppContext → user.uniqueId /
// nickname / secUid. The `sessionid` cookie only tells us *that* someone is
// logged in, never who, so the payload is the only reliable source.
//
// We read uniqueId (@handle), nickname (display name) and the numeric id.
// Nothing here reads cookie *values* — a session cookie is never exfiltrated.

const TIKTOK_HOST_RE = /(^|\.)tiktok\.com$/i;

function isTiktokUrl(url) {
  try { return TIKTOK_HOST_RE.test(new URL(String(url || "")).hostname); } catch (e) { return false; }
}

const TIKTOK_IDENTITY_SCRIPT = `(() => {
  try {
    const readJson = (id) => {
      const el = document.getElementById(id);
      if (!el || !el.textContent) return null;
      try { return JSON.parse(el.textContent); } catch (e) { return null; }
    };
    // 新版:__UNIVERSAL_DATA_FOR_REHYDRATION__ 里 webapp.app-context 带当前登录用户
    const uni = readJson("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    const scopes = (uni && uni.__DEFAULT_SCOPE__) || {};
    const ctx = scopes["webapp.app-context"] || {};
    let uniqueId = ctx.userId ? "" : "";
    let nickname = "", id = "", secUid = "";
    if (ctx && (ctx.uniqueId || ctx.userId)) {
      uniqueId = ctx.uniqueId || "";
      id = String(ctx.userId || "");
      nickname = ctx.nickName || ctx.nickname || "";
      secUid = ctx.secUserId || "";
    }
    // 旧版:SIGI_STATE.AppContext / UserModule
    if (!uniqueId && !id) {
      const sigi = readJson("SIGI_STATE") || (window.SIGI_STATE || null);
      const app = (sigi && (sigi.AppContext || sigi.appContext)) || {};
      uniqueId = app.uniqueId || uniqueId;
      id = String(app.userId || id || "");
      nickname = app.nickName || app.nickname || nickname;
      secUid = app.secUserId || secUid;
    }
    // 兜底:整页 HTML 里捞一次(结构变了也还能读到)
    if (!uniqueId && !id) {
      const html = document.documentElement ? document.documentElement.innerHTML : "";
      uniqueId = (html.match(/"uniqueId":"((?:[^"\\\\]|\\\\.)*)"/) || [])[1] || "";
      nickname = (html.match(/"nickname":"((?:[^"\\\\]|\\\\.)*)"/) || [])[1] || nickname;
      id = (html.match(/"userId":"(\\d+)"/) || [])[1] || id;
    }
    const dec = (s) => { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } };
    if (!uniqueId && !id) return null;
    return { id: String(id || ""), username: dec(uniqueId || ""), displayName: dec(nickname || ""), secUid: String(secUid || "") };
  } catch (e) { return null; }
})()`;

function normalizeTiktokIdentity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const username = s(raw.username).replace(/^@/, "");
  const id = s(raw.id);
  // TikTok 的 @handle 才是人认得出的身份;没有 handle 只有数字 id 也算数,但两者都空就不成立
  if (!username && (!id || id === "0")) return null;
  return { id: id && id !== "0" ? id : "", username, displayName: s(raw.displayName), phone: "" };
}

// Profile-store login record (keyed by name "tiktok").
// username 存 @handle —— 和 telegram 存 handle、facebook 存数字 id 保持一致的语义:
// 这一列永远是「人能认出来的账号标识」。
function tiktokLoginRecord(identity) {
  const it = normalizeTiktokIdentity(identity);
  if (!it) return null;
  return {
    url: "https://www.tiktok.com",
    name: "tiktok",
    username: it.username || it.id,
    mobile: "",
    note: it.displayName,
  };
}

// Reverse: identity view from a stored profile (for list rendering).
function tiktokIdentityFromProfile(profile) {
  const logins = profile && Array.isArray(profile.logins) ? profile.logins : [];
  const l = logins.find((x) => String((x && x.name) || "").toLowerCase() === "tiktok");
  if (!l) return null;
  return { id: "", username: String(l.username || ""), displayName: String(l.note || ""), phone: "" };
}

module.exports = {
  isTiktokUrl,
  TIKTOK_IDENTITY_SCRIPT,
  normalizeTiktokIdentity,
  tiktokLoginRecord,
  tiktokIdentityFromProfile,
};
