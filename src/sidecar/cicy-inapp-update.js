// In-app cicy-code update over the container's OWN API — cicy-code's native
// upgrade path (POST /api/cicy-update). The updater runs INSIDE the container
// (setsid'd, survives the supervisor restart), so the desktop needs neither
// `docker exec` nor a script push into /usr/local/bin — the two steps that kept
// failing ("cannot execute: required file not found", EACCES, wrong container).
//
// The host still resolves the version (fast, host network) and PINS it via
// `target`, so the container never runs its own slow `npm view`.
const http = require("node:http");

function httpJson(method, port, urlPath, { token = "", body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, path: urlPath, method, timeout: timeoutMs,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

// GET /api/health → running version (or null while the server is restarting).
async function healthVersion(port) {
  try {
    const r = await httpJson("GET", port, "/api/health", { timeoutMs: 3000 });
    return r.status === 200 && r.json && r.json.version ? String(r.json.version) : null;
  } catch { return null; }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { started, ok, reason, version }.
//  started=false → caller should fall back to its legacy path (API unreachable,
//                   rejected token, updater missing in this image, …).
//  started=true  → the container is updating; ok tells whether the new version
//                   came back healthy within waitMs.
async function inAppUpdate({ port = 8008, token, target, registry = "", emit = () => {}, waitMs = 300000, pollMs = 3000, sleep = defaultSleep, now = Date.now } = {}) {
  if (!token) return { started: false, reason: "no_token" };
  let res;
  try {
    res = await httpJson("POST", port, "/api/cicy-update", { token, body: { target: target || "", registry }, timeoutMs: 20000 });
  } catch (e) {
    return { started: false, reason: `api_unreachable: ${e.message}` };
  }
  if (res.status === 401 || res.status === 403) return { started: false, reason: `unauthorized (${res.status})` };
  if (res.status !== 200 || !res.json) return { started: false, reason: `http ${res.status}` };
  if (res.json.started !== true) {
    const err = String(res.json.error || "");
    if (/already up to date/i.test(err)) return { started: true, ok: true, alreadyLatest: true, version: String(res.json.current || target || "") };
    return { started: false, reason: err || "not started" };
  }
  const want = String(res.json.target || target || "");
  emit({ phase: "image", status: "running", message: `cicy-code → v${want} (in-app)` });
  const deadline = now() + waitMs;
  let sawDown = false;
  while (now() < deadline) {
    const v = await healthVersion(port);
    if (v === null) sawDown = true;
    else if (v === want) return { started: true, ok: true, version: v };
    // Same old version still answering: the updater is installing (npm) — keep
    // waiting; once it repoints + restarts, health drops and comes back new.
    await sleep(pollMs);
  }
  return { started: true, ok: false, reason: sawDown ? "restarted but not healthy in time" : "updater did not switch version in time", version: want };
}

module.exports = { inAppUpdate, healthVersion, httpJson };
