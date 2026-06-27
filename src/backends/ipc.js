// Main-side IPC for the homepage. Same backends:* / windows:* / updates:*
// contract as before plus the "one rebuild for the year" additions below
// (app, shell, tos, logs). Anything more specific should go through the
// existing `rpc` channel (window.electronRPC) and a tool in src/tools/.

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");
const { ipcMain, clipboard, shell, app } = require("electron");

const registry = require("./registry");
const { openWindowForBackend } = require("./window-manager");
const { openHomepage } = require("./homepage-window");
const { probeBackend, probeAll } = require("./poller");
const updater = require("./updater");
const sidecar = require("../sidecar/cicy-code");
const windowTracker = require("./window-tracker");

function probeArbitrary({ url, token, timeoutMs = 3500 }) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: "invalid url" }); }
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: "/api/health",
      timeout: timeoutMs,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    const req = lib.request(opts, res => {
      res.resume();
      resolve({ ok: res.statusCode < 500, statusCode: res.statusCode });
    });
    req.on("error", e => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
}

function tosPath() { return path.join(app.getPath("userData"), "tos.json"); }
function readTos() {
  try { return JSON.parse(fs.readFileSync(tosPath(), "utf8")); }
  catch { return { version: null, acceptedAt: null }; }
}
function writeTos(data) {
  const p = tosPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function tailLog({ name, lines }) {
  // Whitelisted log targets — never let renderer name an arbitrary path.
  const home = app.getPath("home");
  const targets = {
    "sidecar":    path.join(home, "logs", "cicy-code-sidecar.log"),
    "desktop":    path.join(home, "logs", `cicy-desktop-${process.env.CICY_DESKTOP_PORT || 8101}.log`),
    "cicy-code":  path.join(home, ".cicy-code.log"),
  };
  const file = targets[name];
  if (!file) return { ok: false, error: `unknown log: ${name}` };
  try {
    const buf = fs.readFileSync(file, "utf8");
    const all = buf.split("\n");
    return { ok: true, file, lines: all.slice(-Math.max(1, Number(lines) || 200)).join("\n") };
  } catch (e) {
    return { ok: false, file, error: e.message };
  }
}

let registered = false;
function register(opts = {}) {
  if (registered) return;
  registered = true;

  // --- backends ---
  ipcMain.handle("backends:list", async () => {
    const { resolveBackendUrl } = require("./window-manager");
    return Promise.all(registry.list().map(async b => ({ ...b, resolvedUrl: await resolveBackendUrl(b) })));
  });
  // Resolve a single backend URL on demand (e.g. just before open_window so
  // the token is always fresh rather than stale from the last loadBackends).
  ipcMain.handle("backends:resolve-url", async (_e, id) => {
    const { resolveBackendUrl } = require("./window-manager");
    const b = registry.get(id);
    if (!b) return null;
    return await resolveBackendUrl(b);
  });
  ipcMain.handle("backends:add", (_e, input) => registry.add(input || {}));
  ipcMain.handle("backends:remove", (_e, id) => registry.remove(id));
  ipcMain.handle("backends:update", (_e, input) => registry.update(input || {}));
  ipcMain.handle("backends:probe", (_e, input) => probeArbitrary(input || {}));
  ipcMain.handle("backends:open", async (_e, id) => {
    try {
      const b = registry.get(id);
      if (!b) return { ok: false, error: "backend not found" };
      const win = await openWindowForBackend(b, opts);
      if (win && win.id) windowTracker.register(win, id);
      return { ok: true, windowId: win && win.id };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
  ipcMain.handle("backends:health", async (_e, id) => {
    const b = registry.get(id);
    if (!b) return { ok: false, error: "backend not found" };
    return probeBackend(b);
  });
  ipcMain.handle("backends:health-all", async () => probeAll(registry.list()));
  ipcMain.handle("backends:restart-sidecar", async () => {
    try {
      const { execFile } = require("child_process");
      const port = 8008;

      // Kill by PID from lsof (works on same-user processes, fails EPERM for
      // other-user processes). Falls back to pkill for Windows.
      const killByPort = () => new Promise(resolve => {
        if (process.platform === "win32") {
          execFile("taskkill", ["/F", "/IM", "cicy-code.exe"], () => resolve(true));
          return;
        }
        execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], (_, out) => {
          const pid = parseInt((out || "").trim().split("\n")[0], 10);
          if (!pid) return resolve(false);
          try { process.kill(pid, 9); resolve(true); } catch { resolve(false); }
        });
      });

      // Windows: the daemon runs in Docker; sidecar.stop() removes the
      // container. (Was wsl.stop() — WSL path retired.)
      await killByPort();
      try { await sidecar.stop({ timeoutMs: 500 }); } catch {}

      // Poll until port frees (up to 5s)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await sidecar.probeExisting(port))) {
        await new Promise(r => setTimeout(r, 200));
      }

      const child = await sidecar.start({ logPath: opts.sidecarLogPath, force: true });
      if (!child || !child.pid) {
        return { ok: false, error: "spawn returned no child (port may still be busy)" };
      }
      return { ok: true, pid: child.pid };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // --- windows ---
  ipcMain.handle("windows:list", () => windowTracker.list());
  ipcMain.handle("windows:focus", (_e, id) => windowTracker.focus(Number(id)));

  // --- updates ---
  ipcMain.handle("updates:check", async () => {
    const localBackend = registry.get(registry.LOCAL_ID);
    let currentVersion = null;
    if (localBackend) {
      try {
        const h = await probeBackend(localBackend);
        if (h && h.ok && h.version) currentVersion = h.version;
      } catch {}
    }
    return updater.checkForUpdate({ currentVersion });
  });
  ipcMain.handle("updates:open-release-page", (_e, url) => updater.openReleaseInBrowser(url));

  // App-level (electron-updater) — check status, trigger install
  const appUpdater = require("../app-updater");
  ipcMain.handle("app:update-state",    () => appUpdater.getState());
  ipcMain.handle("app:check-update",    async () => { await appUpdater.check(); return appUpdater.getState(); });
  ipcMain.handle("app:install-update",  () => { appUpdater.installNow(); return true; });

  // Static version info: cicy-desktop's own version + the cicy-code version we
  // actually ship. 主人(2026-06): the real bundled cicy-code = the per-platform
  // optionalDependency (localbin.bundledVersion), not the retired `.cicy-code-ref`
  // source-build pin (which was stale + never packaged). Used by the homepage
  // footer to show "CiCy Desktop vX.Y · cicy-code vA.B".
  ipcMain.handle("app:get-version", () => {
    let cicyCodeRef = "";
    try {
      const bv = require("../sidecar/localbin").bundledVersion("cicy-code");
      if (bv) cicyCodeRef = `v${bv}`;
    } catch {}
    return {
      desktop: app.getVersion(),
      cicyCodeRef,                            // e.g. "v2.3.22" — the bundled cicy-code
      electron: process.versions.electron,
      node:     process.versions.node,
      chrome:   process.versions.chrome,
    };
  });

  // --- clipboard ---
  ipcMain.handle("clipboard:write", (_e, text) => {
    clipboard.writeText(String(text || ""));
    return true;
  });

  // --- shell / app / tos / logs (last rebuild!) ---
  ipcMain.handle("shell:open-external", async (_e, url) => {
    if (!url) return false;
    // Robust open: shell.openExternal silently fails on some Windows profiles;
    // fall back to rundll32/explorer/start (the "手动打开" button uses this too).
    const { openExternalRobust } = require("./open-external");
    return await openExternalRobust(url);
  });
  ipcMain.handle("app:quit", () => {
    setTimeout(() => app.quit(), 100);
    return true;
  });
  ipcMain.handle("tos:get", () => readTos());
  ipcMain.handle("tos:accept", (_e, version) => {
    writeTos({ version: String(version || ""), acceptedAt: new Date().toISOString() });
    return { ok: true, ...readTos() };
  });
  ipcMain.handle("logs:tail", (_e, input) => tailLog(input || {}));

  // ── Trusted origins (Chrome-style site-settings allowlist) ──────────────────
  // The ONLY user-controlled source of "which sites may receive the electronRPC
  // bridge (= run commands locally)". Every write refreshes the cached set in
  // window-utils so isTrustedUrl() takes effect immediately (no restart).
  ipcMain.handle("trustedOrigins:list", () => {
    return require("../profiles/trusted-origins-store").listForUi();
  });
  ipcMain.handle("trustedOrigins:add", (_e, host) => {
    const r = require("../profiles/trusted-origins-store").add(host);
    try { require("../utils/window-utils").refreshTrustedOrigins(); } catch {}
    return r;
  });
  ipcMain.handle("trustedOrigins:remove", (_e, host) => {
    const r = require("../profiles/trusted-origins-store").remove(host);
    try { require("../utils/window-utils").refreshTrustedOrigins(); } catch {}
    return r;
  });

  // ── Open / reload a URL as a TAB in profile 0's tab browser ─────────────────
  // Homepage cards (incl. cloud team cards) open the same way the local card does
  // — a tab in the current profile (0) — instead of a new window / system browser.
  ipcMain.handle("tabs:open", async (_e, input) => {
    try {
      const tb = require("../tools/tab-browser-tools");
      const r = await tb.openTab(0, String((input && input.url) || ""), { systemOpen: true, trusted: false, title: (input && input.title) || "" });
      return { ok: true, winId: r.winId, tabId: r.tabId };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // Open a URL as a tab in a SPECIFIC profile (accountIdx → persist:sandbox-N),
  // not just profile 0. cicy-ai 云端页面(我的钱包/帐单/团队帐单/新加团队)开在
  // profile 1(走 proxy),不再用系统浏览器。profile≠0 会开它自己的标签窗口。
  ipcMain.handle("tabs:openIn", async (_e, input) => {
    try {
      const tb = require("../tools/tab-browser-tools");
      const idx = Number((input && input.accountIdx) || 0) || 0;
      const r = await tb.openTab(idx, String((input && input.url) || ""), { systemOpen: true, trusted: false, title: (input && input.title) || "" });
      return { ok: true, winId: r.winId, tabId: r.tabId };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle("tabs:reload", async (_e, input) => {
    try {
      const tb = require("../tools/tab-browser-tools");
      return await tb.reloadTabByUrl(0, String((input && input.url) || ""), { title: (input && input.title) || "" });
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // Like tabs:reload but NEVER opens a new tab — reloads only if a matching tab
  // is already open, else { ok:false, error:"no_open_window" }. 主人令:刷新窗口
  // 不替用户开窗。所有团队卡(含私有云/共享 TeamCard)的"刷新窗口"走这个。
  ipcMain.handle("tabs:reloadIfOpen", async (_e, input) => {
    try {
      const tb = require("../tools/tab-browser-tools");
      return tb.reloadTabIfOpen(0, String((input && input.url) || ""), { title: (input && input.title) || "" });
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // Just bring an already-open tab to front (no reload, no token, no new tab).
  // 给「打开很慢」用:卡片先探这个,命中就秒切;没命中(没开过)再走慢的拿 token 开 tab。
  ipcMain.handle("tabs:activateIfOpen", async (_e, input) => {
    try {
      const tb = require("../tools/tab-browser-tools");
      return tb.activateTabIfOpen(0, String((input && input.url) || ""));
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ── RPC audit log (read-only viewer) ────────────────────────────────────────
  // JSONL at ~/cicy-ai/db/rpc-audit.log (utils/rpc-audit.js): every electronRPC
  // call + every authorization decision (incl. temporary ones) + allowlist edits.
  // Returns the most recent `limit` entries newest-first; merges the rotated .1
  // file when the live log is short. Read-only — the UI reviews, never mutates.
  ipcMain.handle("rpcAudit:tail", (_e, input) => {
    const limit = Math.max(1, Math.min(2000, Number((input && input.limit) || 300)));
    try {
      const { LOG } = require("../utils/rpc-audit");
      const fs = require("fs");
      const read = (p) => { try { return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean); } catch { return []; } };
      let lines = read(LOG);
      if (lines.length < limit) lines = read(LOG + ".1").concat(lines); // older file first
      const entries = [];
      for (const ln of lines.slice(-limit)) { try { entries.push(JSON.parse(ln)); } catch {} }
      entries.reverse(); // newest first
      return { ok: true, entries, path: LOG };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), entries: [] };
    }
  });
}

module.exports = { register, openHomepage };
