// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Owner-hub trust — the SET of hub hosts a hub-logged-in desktop treats as "its
// owner commanding it", so rpc_call from the operator's own ws-hub control surface
// (or any of the owner's own nodes) can drive dangerous tools (exec_*/file_*/
// electron_inject) on this machine WITHOUT a per-call consent modal nobody is
// present to click.
//
// Scope (the narrowest boundary that still gives fleet control):
//   • Each of the owner's nodes is served at its OWN subdomain
//     https://<node>.hub.cicy-ai.com (confirmed from the live instances list) —
//     so owner-trust is a SET of hosts, not one.
//   • Every host in the set is captured ONLY from an authenticated source proven
//     to belong to THIS desktop's owner email:
//       – a hub grant minted with this desktop's own hubAuth token (grantUrl), and
//       – the instances() list fetched with that same token.
//     Both prove the host is the owner's; no origin-string guessing, no
//     email→slug derivation, no bare `.hub.cicy-ai.com` wildcard (that would
//     trust a DIFFERENT tenant's subdomain).
//   • Persisted under hubAuth so it survives restart; cleared on logout.
//   • Every host is suffix-locked to an exact single-label <tenant>.hub.cicy-ai.com.
const os = require("os");
const path = require("path");
const { readGlobalConfig, updateGlobalConfig } = require("./global-json");

const GLOBAL_JSON = path.join(os.homedir(), "cicy-ai", "global.json");
const HUB_SUFFIX = ".hub.cicy-ai.com";

let _audit = () => {};
try {
  _audit = require("./rpc-audit").audit;
} catch {}

function normHubHost(input) {
  if (!input || typeof input !== "string") return "";
  let s = input.trim().toLowerCase();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return "";
    }
  }
  s = s.split("/")[0].split("?")[0].split("#")[0].replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/.test(s)) return "";
  // Must be an exact <tenant>.hub.cicy-ai.com host — suffix match plus a real
  // single-label tenant in front (no bare "hub.cicy-ai.com", no nested dots).
  if (!s.endsWith(HUB_SUFFIX)) return "";
  const tenant = s.slice(0, -HUB_SUFFIX.length);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) return "";
  return s;
}

// True only while the desktop is signed in to the hub (owner trust dies with the
// session).
function loggedIn() {
  try {
    const a = readGlobalConfig(GLOBAL_JSON)?.hubAuth;
    return !!(a && a.token);
  } catch {
    return false;
  }
}

// The trusted host set, read fresh from disk. Honours a legacy single
// `ownerHubHost` string alongside the `ownerHubHosts` array.
function _readHosts() {
  try {
    const a = readGlobalConfig(GLOBAL_JSON)?.hubAuth;
    if (!a) return [];
    const out = [];
    const push = (h) => {
      const n = normHubHost(h);
      if (n && !out.includes(n)) out.push(n);
    };
    if (Array.isArray(a.ownerHubHosts)) a.ownerHubHosts.forEach(push);
    if (a.ownerHubHome) push(a.ownerHubHome);
    if (a.ownerHubHost) push(a.ownerHubHost); // legacy single-host field
    return out;
  } catch {
    return [];
  }
}

function ownerHubHosts() {
  return _readHosts();
}

// The primary "owner's own hub home" — used to build an "open my hub at project X"
// URL. First host recorded via a grant (grantUrl); falls back to any known host.
function ownerHubHost() {
  try {
    const home = normHubHost(readGlobalConfig(GLOBAL_JSON)?.hubAuth?.ownerHubHome || "");
    if (home) return home;
  } catch {}
  return _readHosts()[0] || "";
}

// Add hosts to the trusted set (only while a token is present). `setHome` marks
// the first one as the primary home (grants do this; the instances bulk load
// doesn't, so a node subdomain never becomes "my hub home").
function _addHosts(hosts, setHome) {
  const norm = (Array.isArray(hosts) ? hosts : [hosts]).map(normHubHost).filter(Boolean);
  if (!norm.length) return { ok: false, added: 0 };
  const have = new Set(_readHosts());
  const add = norm.filter((h) => !have.has(h));
  let homeToSet = "";
  try {
    updateGlobalConfig(GLOBAL_JSON, (c) => {
      if (c && c.hubAuth && c.hubAuth.token) {
        const cur = Array.isArray(c.hubAuth.ownerHubHosts) ? c.hubAuth.ownerHubHosts.slice() : [];
        const s = new Set(cur);
        if (c.hubAuth.ownerHubHost) {
          const legacy = normHubHost(c.hubAuth.ownerHubHost);
          if (legacy) s.add(legacy);
          delete c.hubAuth.ownerHubHost; // migrate
        }
        norm.forEach((h) => s.add(h));
        c.hubAuth.ownerHubHosts = Array.from(s);
        if (setHome && !c.hubAuth.ownerHubHome) {
          c.hubAuth.ownerHubHome = norm[0];
          homeToSet = norm[0];
        }
      }
      return c;
    });
  } catch {
    return { ok: false, added: 0 };
  }
  if (add.length || homeToSet) {
    _audit({
      kind: "auth",
      gate: "owner-hub",
      host: (add.length ? add : norm).join(","),
      decision: setHome ? "record" : "record-bulk",
    });
  }
  return { ok: true, added: add.length };
}

// A single host proven to be the owner's (a grant). Also becomes the primary home.
function recordOwnerHubHost(input) {
  const host = normHubHost(input);
  if (!host) return { ok: false };
  const r = _addHosts([host], true);
  return r.ok ? { ok: true, host } : { ok: false };
}

// Bulk: every host from the authenticated instances() list — all the owner's own
// nodes. Does NOT change the primary home.
function recordOwnerHubHosts(list) {
  return _addHosts(list, false);
}

function clearOwnerHubHost() {
  try {
    updateGlobalConfig(GLOBAL_JSON, (c) => {
      if (c && c.hubAuth) {
        delete c.hubAuth.ownerHubHost;
        delete c.hubAuth.ownerHubHome;
        delete c.hubAuth.ownerHubHosts;
      }
      return c;
    });
  } catch {}
}

// The gate: is this origin one of the owner's own hub hosts (and are we still
// logged in)? Suffix-locked AND matched against the captured set.
function isOwnerHubOrigin(originOrUrl) {
  if (!loggedIn()) return false;
  const host = normHubHost(originOrUrl);
  if (!host) return false;
  return _readHosts().includes(host);
}

module.exports = {
  HUB_SUFFIX,
  normHubHost,
  ownerHubHost,
  ownerHubHosts,
  recordOwnerHubHost,
  recordOwnerHubHosts,
  clearOwnerHubHost,
  isOwnerHubOrigin,
};
