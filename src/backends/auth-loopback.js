// Loopback browser-login listener.
//
// Flow (B-variant of OAuth-style desktop login — same pattern as `gcloud
// auth login`, `gh auth login`, VSCode GitHub):
//
//   1. main opens an HTTP server on 127.0.0.1:<random port>, route `/cb`.
//   2. main calls shell.openExternal(`https://cicy-ai.com/login?…`) with
//      a fresh `state` nonce and the loopback `next` URL.
//   3. user logs in in their default browser. cicy-ai.com 302s back to
//      `http://127.0.0.1:<port>/cb?token=sk-…&state=<same nonce>`.
//   4. the listener verifies the state, returns a "登录成功" HTML page to
//      the browser, and fires `onResult({ token, state })`.
//   5. server self-closes 500 ms later.
//
// State-nonce mismatch / timeout / shutdown all close the server cleanly
// and call `onResult({ error })` so the renderer can re-enable its button.

const http = require("http");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { shell } = require("electron");
const log = require("electron-log");

const LOGIN_BASE = "https://cicy-ai.com/login";

// Styled /cb success page (dark, CiCy-branded — matches the landing). Shipped
// alongside this module so it works in the packaged app; falls back to a plain
// inline page if the file is somehow missing.
const SUCCESS_FALLBACK = `<!doctype html><meta charset="utf-8">
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px;color:#222;background:#f7f8fa">
  <h1 style="color:#10b981;margin-bottom:8px">登录成功 ✓</h1>
  <p style="opacity:.7">请回到 CiCy Desktop 继续使用。</p>
  <p style="opacity:.4;font-size:13px;margin-top:32px">此页面可以安全关闭。</p>
</body>`;
const SUCCESS_HTML = (() => {
  try { return fs.readFileSync(path.join(__dirname, "login-success.html"), "utf8"); }
  catch (e) { log.warn(`[auth-loopback] success page load failed, using fallback: ${e.message}`); return SUCCESS_FALLBACK; }
})();
// 120 s — per w-10032 cloud spec. Cloud-side fallback when /exchange fails
// is to redirect to /team/dashboard, NOT back to our loopback, so the
// listener never sees a result and must self-time-out instead of hanging
// the renderer's "登录中…" state forever.
const LOGIN_TIMEOUT_MS = 120_000;

let _server = null;
let _state = null;
let _timeoutHandle = null;

function shutdown(reason) {
  if (_timeoutHandle) { clearTimeout(_timeoutHandle); _timeoutHandle = null; }
  if (_server) {
    try { _server.close(); } catch {}
    _server = null;
  }
  _state = null;
  if (reason) log.info(`[auth-loopback] shutdown: ${reason}`);
}

async function startLogin({ onResult } = {}) {
  // Cancel any in-flight attempt — last click wins.
  shutdown("new login attempt");

  _state = crypto.randomBytes(16).toString("hex");
  const expectedState = _state;

  _server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, `http://127.0.0.1`); }
    catch { res.writeHead(400); res.end("bad request"); return; }

    if (url.pathname !== "/cb") {
      res.writeHead(404); res.end("not found");
      return;
    }

    const token = url.searchParams.get("token") || "";
    const state = url.searchParams.get("state") || "";
    // `reused=true` means the cloud's `/api/user/desktop/exchange` returned
    // an existing token for this client_name rather than minting a new one.
    // UX-only — drives the "已恢复登录" vs "登录成功" copy on the renderer.
    const reused = url.searchParams.get("reused") === "true";
    // `access_token` is the console-API bearer (different from the sk-xxx
    // LLM-API token). Needed to call /api/user/self + /api/teams etc.
    // Loopback is 127.0.0.1 so it never leaves the user's machine; same
    // trust boundary as the renderer's localStorage.
    const accessToken = url.searchParams.get("access_token") || "";
    // `user_id` is required as the New-Api-User header on every console
    // call — middleware.UserAuth() rejects requests without it. Cloud sends
    // it in the v5+ callback URL.
    const userId = url.searchParams.get("user_id") || "";

    if (state !== expectedState) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8">
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px;color:#444">
  <h1 style="color:#c00">登录失败</h1>
  <p>state 校验未通过，请回到 CiCy Desktop 重新点击 Login。</p>
</body>`);
      try { onResult && onResult({ error: "state mismatch" }); } catch {}
      setTimeout(() => shutdown("state mismatch"), 500);
      return;
    }

    if (!token) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8">
<body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px;color:#444">
  <h1 style="color:#c00">登录失败</h1>
  <p>未收到 token，请回到 CiCy Desktop 重试。</p>
</body>`);
      try { onResult && onResult({ error: "no token" }); } catch {}
      setTimeout(() => shutdown("no token"), 500);
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SUCCESS_HTML);
    try { onResult && onResult({ token, state, reused, accessToken, userId }); } catch {}
    setTimeout(() => shutdown("login complete"), 500);
  });

  return new Promise((resolve, reject) => {
    _server.once("error", (err) => { shutdown(`listen error: ${err.message}`); reject(err); });
    _server.listen(0, "127.0.0.1", () => {
      const port = _server.address().port;
      const params = new URLSearchParams({
        client: "desktop",
        state: expectedState,
        next: `http://127.0.0.1:${port}/cb`,
        client_name: os.hostname(),
      });
      const url = `${LOGIN_BASE}?${params.toString()}`;
      log.info(`[auth-loopback] listening :${port}, opening ${url}`);
      shell.openExternal(url).catch((e) => log.warn(`[auth-loopback] openExternal failed: ${e.message}`));

      _timeoutHandle = setTimeout(() => {
        try { onResult && onResult({ error: "timeout" }); } catch {}
        shutdown("timeout");
      }, LOGIN_TIMEOUT_MS);

      resolve({ port, state: expectedState });
    });
  });
}

function cancel() {
  shutdown("cancelled by user");
}

module.exports = { startLogin, cancel };
