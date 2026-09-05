// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

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
const fs = require("fs");
const path = require("path");
const _handled = new WeakSet(); // sessions that already have the cicyui handler

// cicyui://panel/<id> — the split-webview panel page (opened by the tab strip's
// top-right "+"). <id> keeps each panel tab's URL unique so addTab's
// origin+pathname reuse never collapses two panels into one; the page keys its
// persisted layout off the same path.
const { panelPageForUrl } = require("./panel-page-router");
const PANEL_REMOTE_BASE =
  process.env.CICY_PANEL_BASE || "https://desktop.cicy-ai.com/panel";

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
      if (host === "panel") {
        // The panel pages (矩阵 / split panel) are also published by the
        // desktop-render Worker, so their UI ships by deploying rather than by
        // releasing the app. Fetching them here — instead of pointing the tab at
        // an https:// URL — keeps the URL, and therefore the panel preload and
        // the page origin, exactly as they were: only the HTML travels. Same
        // shape the newtab branch below already uses.
        //
        // The bundled copy under src/tabbrowser stays the fallback, so a CDN
        // outage (or a dev editing the local file) still works. Local edits land
        // on a tab reload with CICY_PANEL_LOCAL=1.
        const name = panelPageForUrl(request.url);
        if (process.env.CICY_PANEL_LOCAL !== "1") {
          try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 4000);
            // Workers Assets serves extensionless paths and 307s /x.html → /x,
            // so ask for the canonical form and skip the redirect hop.
            const remoteName = name.replace(/\.html$/, "");
            const up = await fetch(`${PANEL_REMOTE_BASE}/${remoteName}`, { signal: ctl.signal, cache: "no-store" });
            clearTimeout(t);
            const body = up.ok ? await up.text() : "";
            // The Worker serves the SPA with single-page-application fallback, so
            // an unknown path answers 200 + index.html. Take the body only when it
            // is NOT that shell — the shell is the one page carrying both #root
            // and a hashed assets/index-*.js, neither of which any panel page has.
            const spaShell = /id="root"/.test(body) && /assets\/index-[A-Za-z0-9_-]+\.js/.test(body);
            if (body && /<!doctype html>/i.test(body) && !spaShell) {
              return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
            }
          } catch (e) {
            // fall through to the bundled copy
          }
        }
        try {
          const file = path.join(__dirname, name);
          const html = await fs.promises.readFile(file, "utf8");
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        } catch (e) { return new Response("panel page missing", { status: 500 }); }
      }
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

// Panel tabs load straight from the network (desktop.cicy-ai.com/panel/<page>)
// so the address bar shows the real https URL — the page ships by deploying the
// Worker, same as before. panelAPI still reaches the page: buildTabWebPreferences
// applies PANEL_PRELOAD (sandbox kept ON) to any tab whose URL starts with this
// base. The cicyui://panel handler above stays as an offline/legacy fallback.
const PANEL_URL_BASE = PANEL_REMOTE_BASE.replace(/\/+$/, "") + "/";
module.exports = { NEWTAB_URL, PANEL_URL_BASE, registerScheme, installHandler, ensureForPartition, startPageHtml };
