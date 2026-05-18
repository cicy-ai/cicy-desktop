// Probes each backend's /api/health and returns the JSON payload. Used by
// the homepage to populate per-backend status (uptime, mem, agents count).
// Stateless — homepage caches results in renderer-side state.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { resolveBackendUrl } = require("./window-manager");

function probeBackend(backend, { timeoutMs = 4000 } = {}) {
  return new Promise(resolve => {
    if (!backend) return resolve({ ok: false, error: "no backend" });
    const baseUrl = resolveBackendUrl(backend);
    if (!baseUrl) return resolve({ ok: false, error: "no url" });
    let u;
    try {
      // Strip any token query for /api/health; the endpoint is unauthenticated.
      const tmp = new URL(baseUrl);
      tmp.search = "";
      tmp.pathname = "/api/health";
      u = tmp;
    } catch (e) {
      return resolve({ ok: false, error: "invalid url" });
    }
    const lib = u.protocol === "https:" ? https : http;
    const headers = {};
    if (backend.token) headers.Authorization = `Bearer ${backend.token}`;
    const started = Date.now();
    const req = lib.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      timeout: timeoutMs,
      headers,
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; if (body.length > 64 * 1024) { req.destroy(); resolve({ ok: false, error: "body too large" }); }});
      res.on("end", () => {
        const latencyMs = Date.now() - started;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, statusCode: res.statusCode, latencyMs });
        }
        try {
          const data = JSON.parse(body);
          resolve({ ok: true, statusCode: res.statusCode, latencyMs, ...data });
        } catch (e) {
          resolve({ ok: false, error: "invalid json", latencyMs });
        }
      });
    });
    req.on("error", e => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
}

async function probeAll(backends) {
  return Promise.all(backends.map(b => probeBackend(b).then(h => ({ id: b.id, health: h }))));
}

module.exports = { probeBackend, probeAll };
