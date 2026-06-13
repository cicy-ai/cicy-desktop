// cicy://newtab — the tab browser's start page, served via a custom scheme so a
// new tab's URL is a clean "cicy://newtab" instead of a giant inline data: URL
// (主人令: url 不要那串 data: 天书). Chrome's chrome://newtab analog.
const { protocol, session } = require("electron");
const _handled = new WeakSet(); // sessions that already have the cicyui handler

// NOTE: scheme is "cicyui", NOT "cicy" — "cicy" is already an OS deep-link
// protocol client (setAsDefaultProtocolClient), so navigating a webContents to
// cicy://… gets dispatched externally (open-url) and the page never renders.
// A dedicated scheme avoids that collision.
const NEWTAB_URL = "cicyui://newtab";

function startPageHtml() {
  // <title> → document.title = 起始页 (so the tab isn't titled by its URL).
  return `<!doctype html><meta charset=utf-8><title>起始页</title><style>html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;background:#202124;color:#e8eaed;font-family:-apple-system,sans-serif}.w{text-align:center}.l{width:54px;height:54px;border-radius:16px;margin:0 auto 16px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px}h1{font-size:16px;margin-bottom:6px}p{color:#9aa0a6;font-size:13px}</style><div class=w><div class=l>&#10022;</div><h1>CiCy Browser</h1><p>新标签页</p></div>`;
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
// tab BrowserViews run in those — so each partition session needs its own.
function handlerFor(ses) {
  if (!ses || _handled.has(ses)) return;
  try {
    ses.protocol.handle("cicyui", (request) => {
      let host = "";
      try { host = new URL(request.url).hostname; } catch (e) {}
      if (host === "newtab") {
        return new Response(startPageHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    });
    _handled.add(ses);
  } catch (e) {}
}

// MUST be called AFTER app 'ready' — default session (homepage etc.).
function installHandler() { handlerFor(session.defaultSession); }

// Per-partition session for the tab-browser sandboxes — call before a tab in
// that partition loads cicyui://newtab.
function ensureForPartition(partition) {
  try { handlerFor(session.fromPartition(partition)); } catch (e) {}
}

module.exports = { NEWTAB_URL, registerScheme, installHandler, ensureForPartition, startPageHtml };
