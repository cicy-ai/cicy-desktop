// Email magic-link DEVICE-POLL login — cross-device safe.
//
// The 127.0.0.1 loopback in auth-loopback.js only works when the magic link is
// clicked on the SAME machine: a phone can't reach the desktop's localhost, so a
// link opened on mobile leaves the desktop hanging until timeout (todo#196).
//
// This flow (cloud contract by w-10122) decouples the click from the device:
//   1. desktop generates a high-entropy `state` (it IS the retrieval credential).
//   2. POST /api/auth/email/request {email, state, flow:'desktop_poll'} → cloud
//      registers state=pending and sends the magic-link email.
//   3. user clicks the link on ANY device → cloud mints the session, stores it
//      under `state`, and shows a "回到桌面端" page (no loopback redirect).
//   4. desktop polls GET /api/auth/desktop/poll?state=<state> until it flips to
//      `ready` (one-time consumed), then fires onResult with the SAME payload
//      shape as the loopback flow so main's auth hook is unchanged.
//
// state TTL is 10 min cloud-side; the token is sk-sess- (the SOLE Bearer for all
// /api/* — no exchange, no New-Api-User header needed).

const crypto = require("crypto");
const log = require("electron-log");

const CLOUD_BASE = "https://cicy-ai.com";
const REQUEST_URL = `${CLOUD_BASE}/api/auth/email/request`;
const POLL_URL = `${CLOUD_BASE}/api/auth/desktop/poll`;
const POLL_EVERY_MS = 2500;
const TIMEOUT_MS = 600_000; // 10 min — matches the cloud state TTL.

let _state = null;
let _timer = null;
let _onResult = null;
let _resultFired = false;

function shutdown(reason) {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _state = null;
  if (reason) log.info(`[auth-email] shutdown: ${reason}`);
}

// Deliver the result exactly once — the poll loop, the timeout, and cancel() all
// race to be first (same guard pattern as auth-loopback).
function fire(payload) {
  if (_resultFired) return;
  _resultFired = true;
  try { _onResult && _onResult(payload); } catch {}
}

// Begin the device-poll flow. Resolves once the email has been requested (so the
// renderer can show "邮件已发送"); the actual login lands later via onResult.
async function startEmailLogin({ email, onResult } = {}) {
  shutdown("new email login");
  const addr = String(email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new Error("invalid email");

  _state = crypto.randomBytes(24).toString("hex");
  _resultFired = false;
  _onResult = onResult;
  const state = _state;

  const res = await fetch(REQUEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: addr, state, flow: "desktop_poll" }),
  });
  if (!res.ok) {
    shutdown(`request HTTP ${res.status}`);
    throw new Error(`发送登录邮件失败 (HTTP ${res.status})`);
  }
  log.info(`[auth-email] request sent for ${addr}, polling state ${state.slice(0, 8)}…`);

  const startedAt = Date.now();
  const tick = async () => {
    if (state !== _state) return; // superseded / cancelled
    if (Date.now() - startedAt > TIMEOUT_MS) { fire({ error: "timeout" }); shutdown("timeout"); return; }
    try {
      const r = await fetch(`${POLL_URL}?state=${encodeURIComponent(state)}`);
      if (r.status === 404) { fire({ error: "expired" }); shutdown("poll 404"); return; }
      const j = await r.json().catch(() => ({}));
      if (j.status === "ready" && j.token) {
        // Map cloud fields → the loopback payload shape main already persists.
        // token = access_token = sk-sess- (SOLE Bearer); user_id for any local
        // New-Api-User header (cloud itself doesn't require it).
        fire({
          token: j.token,
          accessToken: j.access_token || j.token,
          userId: j.user_id != null ? String(j.user_id) : "",
          reused: !!j.reused,
          email: j.email || addr,
        });
        shutdown("ready");
        return;
      }
      if (j.status === "expired") { fire({ error: "expired" }); shutdown("expired"); return; }
      // pending → keep polling.
    } catch (e) {
      // Transient network blip — keep polling until the overall timeout.
      log.warn(`[auth-email] poll error (retrying): ${e.message}`);
    }
    if (state === _state) _timer = setTimeout(tick, POLL_EVERY_MS);
  };
  _timer = setTimeout(tick, POLL_EVERY_MS);
  return { state, email: addr };
}

function cancel() {
  if (_state) { fire({ error: "cancelled" }); shutdown("cancelled by user"); }
}

module.exports = { startEmailLogin, cancel };
