// Register main-side IPC handlers for the backend selector / launcher.
// Call register() once from src/main.js after app.whenReady.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { ipcMain } = require("electron");
const registry = require("./registry");
const { openWindowForBackend } = require("./window-manager");
const { openLauncher } = require("./launcher-window");

function probe({ url, token, timeoutMs = 3500 }) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: "invalid url" }); }
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      // /health is a conventional liveness endpoint; cicy-code serves a UI
      // root that 200s too, so accept any 2xx/3xx/4xx (anything but 5xx and
      // connection errors) as proof the host is up.
      path: "/health",
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

let registered = false;
function register(opts = {}) {
  if (registered) return;
  registered = true;

  ipcMain.handle("backends:list", () => registry.list());
  ipcMain.handle("backends:add", (_e, input) => registry.add(input || {}));
  ipcMain.handle("backends:remove", (_e, id) => registry.remove(id));
  ipcMain.handle("backends:probe", (_e, input) => probe(input || {}));
  ipcMain.handle("backends:open", async (_e, id) => {
    try {
      const b = registry.get(id);
      if (!b) return { ok: false, error: "backend not found" };
      const win = await openWindowForBackend(b, opts);
      return { ok: true, windowId: win && win.id };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

module.exports = { register, probe, openLauncher };
