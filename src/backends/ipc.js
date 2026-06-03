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
  ipcMain.handle("backends:list", () => {
    const { resolveBackendUrl } = require("./window-manager");
    return registry.list().map(b => ({ ...b, resolvedUrl: resolveBackendUrl(b) }));
  });
  // Resolve a single backend URL on demand (e.g. just before open_window so
  // the token is always fresh rather than stale from the last loadBackends).
  ipcMain.handle("backends:resolve-url", (_e, id) => {
    const { resolveBackendUrl } = require("./window-manager");
    const b = registry.get(id);
    if (!b) return null;
    return resolveBackendUrl(b);
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

  // Static version info: cicy-desktop's own version + the cicy-code tag
  // we shipped with (`.cicy-code-ref` content from build time). Used by the
  // homepage footer to show "CiCy Desktop vX.Y · cicy-code vA.B".
  ipcMain.handle("app:get-version", () => {
    let cicyCodeRef = "";
    try {
      const refPath = path.join(app.getAppPath(), ".cicy-code-ref");
      cicyCodeRef = require("fs").readFileSync(refPath, "utf8").trim();
    } catch {}
    return {
      desktop: app.getVersion(),
      cicyCodeRef,                            // e.g. "v2.0.11" — what we *intended* to ship
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
  ipcMain.handle("shell:open-external", (_e, url) => {
    if (!url) return false;
    shell.openExternal(String(url));
    return true;
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
}

module.exports = { register, openHomepage };
