// cicyui://newtab — the tab browser's start page, served via a custom scheme so a
// new tab's URL is a clean "cicyui://newtab" instead of a giant inline data: URL
// (url 不要那串 data: 天书). Chrome's chrome://newtab analog.
//
// SINGLE SOURCE: the page itself is served by cicy-code at http://127.0.0.1:PORT/
// newtab?profile=N — this handler just FETCHES that and returns it, so the logo /
// layout / profile pill live in exactly ONE place (cicy-code's /newtab handler)
// and both the Electron tab browser and Chrome's start tab render the same thing.
// If cicy-code is momentarily unreachable we fall back to a minimal inline page so
// a fresh tab is never blank.
const { protocol, session } = require("electron");
const _handled = new WeakSet(); // sessions that already have the cicyui handler

// NOTE: scheme is "cicyui", NOT "cicy" — "cicy" is already an OS deep-link
// protocol client (setAsDefaultProtocolClient), so navigating a webContents to
// cicy://… gets dispatched externally (open-url) and the page never renders.
// A dedicated scheme avoids that collision.
const NEWTAB_URL = "cicyui://newtab";
const CICY_PORT = Number(process.env.CICY_CODE_PORT || 8008);

// accountIdxFromPartition pulls N out of "persist:sandbox-N" (default session /
// system profile → "").
function accountIdxFromPartition(partition) {
  const m = /sandbox-(\d+)/.exec(partition || "");
  return m ? m[1] : "";
}

// startPageHtml is the OFFLINE FALLBACK only — a minimal, self-contained page for
// when cicy-code (:CICY_PORT) can't be reached. The real page comes from
// cicy-code /newtab (see handlerFor). Kept exported for tab-browser.html's inline
// start page.
function startPageHtml(profile) {
  const pill = profile
    ? `<div style="display:inline-block;margin:14px 0 0;padding:4px 12px;border-radius:999px;background:rgba(139,92,246,.18);border:1px solid rgba(139,92,246,.35);color:#c4b5fd;font-size:13px;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace">Profile #${profile}</div>`
    : "";
  return `<!doctype html><meta charset=utf-8><title>起始页</title><style>html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;background:#202124;color:#e8eaed;font-family:-apple-system,sans-serif}.w{text-align:center}.l{width:56px;height:56px;margin:0 auto 16px}.l svg{width:100%;height:100%;display:block}h1{font-size:16px;margin:0 0 6px}p{color:#9aa0a6;font-size:13px;margin:0}</style><div class=w><div class=l><svg viewBox="0 0 96 96" fill="#fff"><path d="M48 11L39.5 33.3L16 29.5L31 48L16 66.5L39.5 62.7L48 85L56.5 62.7L80 66.5L65 48L80 29.5L56.5 33.3Z"/></svg></div><h1>CiCy Browser</h1><p>新标签页</p>${pill}</div>`;
}

// MUST be called BEFORE app 'ready' (registerSchemesAsPrivileged requirement).
function registerScheme() {
  try {
    protocol.registerSchemesAsPrivileged([
      { scheme: "cicyui", privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);
  } catch (e) {}
}

// Register the cicyui handler on a given session. protocol.handle on the global
// (default) session does NOT cover persist:sandbox-N partition sessions — the
// tab BrowserViews run in those — so each partition session needs its own. The
// partition string lets us tell cicy-code which profile this is (Profile #N).
function handlerFor(ses, partition) {
  if (!ses || _handled.has(ses)) return;
  const profile = accountIdxFromPartition(partition);
  try {
    ses.protocol.handle("cicyui", async (request) => {
      let host = "";
      try { host = new URL(request.url).hostname; } catch (e) {}
      if (host !== "newtab") return new Response("not found", { status: 404 });
      // Fetch the single-source page from cicy-code; fall back to the inline page.
      try {
        const up = await fetch(`http://127.0.0.1:${CICY_PORT}/newtab?profile=${encodeURIComponent(profile)}`);
        if (up.ok) {
          const body = await up.text();
          return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
      } catch (e) {}
      return new Response(startPageHtml(profile), { headers: { "content-type": "text/html; charset=utf-8" } });
    });
    _handled.add(ses);
  } catch (e) {}
}

// MUST be called AFTER app 'ready' — default session (homepage etc.).
function installHandler() { handlerFor(session.defaultSession, ""); }

// Per-partition session for the tab-browser sandboxes — call before a tab in
// that partition loads cicyui://newtab.
function ensureForPartition(partition) {
  try { handlerFor(session.fromPartition(partition), partition); } catch (e) {}
}

module.exports = { NEWTAB_URL, registerScheme, installHandler, ensureForPartition, startPageHtml };
