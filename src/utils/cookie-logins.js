// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Shared "which sites is this session logged into?" summarizer for BOTH backends.
//
// Input: an array of cookies, each with at least { name, domain }. Both
// CDP Storage.getCookies (Chrome) and Electron session.cookies.get() return
// that shape, so the same rollup serves chrome + electron tools identically.
//
// Output: per-registrable-domain counts, flagging domains that carry an
// auth/session-looking cookie. That flag is a STRONG SIGNAL, not proof — a
// session cookie can be present while the account is signed out / expired
// (e.g. github keeping `logged_out` cookies). Confirm by loading the site.

// Cookie names that typically indicate an authenticated/session state.
const AUTH_RE = /sid|session|auth|token|login|sapisid|__secure|remember|passport|csrf/i;

// Cheap registrable-domain: last two labels. Good enough for grouping/display;
// not a full Public Suffix List (e.g. foo.co.uk collapses to co.uk).
function registrableDomain(host) {
  const h = String(host || "").replace(/^\./, "").toLowerCase();
  if (!h) return "";
  const parts = h.split(".");
  return parts.length <= 2 ? h : parts.slice(-2).join(".");
}

function summarizeCookieLogins(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  const byDomain = new Map();
  for (const c of list) {
    const d = registrableDomain(c && c.domain);
    if (!d) continue;
    let e = byDomain.get(d);
    if (!e) {
      e = { domain: d, cookies: 0, authCookies: [] };
      byDomain.set(d, e);
    }
    e.cookies += 1;
    if (c && c.name && AUTH_RE.test(c.name) && !e.authCookies.includes(c.name)) {
      e.authCookies.push(c.name);
    }
  }
  const sites = [...byDomain.values()]
    .map((e) => ({
      domain: e.domain,
      cookies: e.cookies,
      loggedIn: e.authCookies.length > 0,
      authCookies: e.authCookies,
    }))
    .sort((a, b) => b.cookies - a.cookies);

  return {
    totalCookies: list.length,
    domains: sites.length,
    loggedIn: sites.filter((s) => s.loggedIn).map((s) => s.domain),
    sites,
    note: "loggedIn = 该域名带会话 cookie，强信号但非确证（cookie 在≠一定登录），可打开站点确认",
  };
}

module.exports = { summarizeCookieLogins, AUTH_RE, registrableDomain };
