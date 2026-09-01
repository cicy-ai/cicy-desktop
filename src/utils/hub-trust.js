// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Owner-hub trust — the ONE origin a hub-logged-in desktop treats as "its owner
// commanding it", so rpc_call from the operator's own ws-hub control surface can
// drive dangerous tools (exec_*/file_*/electron_inject) on this machine WITHOUT a
// per-call consent modal that nobody is present to click.
//
// Scope (deliberately the narrowest that still gives fleet control):
//   • ALL teams under the same login email share ONE origin —
//     https://<tenant>.hub.cicy-ai.com (teams/projects are hash paths under it),
//     confirmed across the fleet. So owner-trust is a single hub host, not a set.
//   • That host is captured ONLY from an authenticated source: a hub grant minted
//     with THIS desktop's own hubAuth token (hub-client.grantUrl / hub:open).
//     Minting a grant proves the host belongs to this desktop's owner email —
//     no origin-string guessing, no email→slug derivation.
//   • Persisted under hubAuth so it survives restart (the deadlock repro was "also
//     after restart"); cleared the moment the desktop logs out.
//   • Suffix-locked to `.hub.cicy-ai.com`: even a corrupted store can't promote an
//     arbitrary origin to owner trust.
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

function ownerHubHost() {
  try {
    return normHubHost(readGlobalConfig(GLOBAL_JSON)?.hubAuth?.ownerHubHost || "");
  } catch {
    return "";
  }
}

// Record the hub host proven to be the owner's (called on a successful grant).
function recordOwnerHubHost(input) {
  const host = normHubHost(input);
  if (!host) return { ok: false };
  if (ownerHubHost() === host) return { ok: true, host };
  try {
    updateGlobalConfig(GLOBAL_JSON, (c) => {
      if (c && c.hubAuth && c.hubAuth.token) c.hubAuth.ownerHubHost = host;
      return c;
    });
  } catch {
    return { ok: false };
  }
  _audit({ kind: "auth", gate: "owner-hub", host, decision: "record" });
  return { ok: true, host };
}

function clearOwnerHubHost() {
  try {
    updateGlobalConfig(GLOBAL_JSON, (c) => {
      if (c && c.hubAuth) delete c.hubAuth.ownerHubHost;
      return c;
    });
  } catch {}
}

// The gate: is this origin the owner's own hub control surface (and are we still
// its owner)? Suffix-locked AND matched against the captured host.
function isOwnerHubOrigin(originOrUrl) {
  if (!loggedIn()) return false;
  const own = ownerHubHost();
  if (!own) return false;
  const host = normHubHost(originOrUrl);
  return !!host && host === own;
}

module.exports = {
  HUB_SUFFIX,
  normHubHost,
  ownerHubHost,
  recordOwnerHubHost,
  clearOwnerHubHost,
  isOwnerHubOrigin,
};
