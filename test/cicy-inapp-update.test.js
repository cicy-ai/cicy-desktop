const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { inAppUpdate } = require("../src/sidecar/cicy-inapp-update");

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

test("inAppUpdate pins the host-resolved target, then waits for the new version to come back", async () => {
  const seen = [];
  let version = "2.3.571";
  const { srv, port } = await serve((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/cicy-update") {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ started: true, current: version, target: "2.3.573" }));
        setTimeout(() => { version = "2.3.573"; }, 30);
        return;
      }
      if (req.url === "/api/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "ok", version })); return; }
      res.statusCode = 404; res.end();
    });
  });
  try {
    const r = await inAppUpdate({ port, token: "cicy_tok", target: "2.3.573", registry: "https://registry.npmmirror.com", pollMs: 10, waitMs: 5000 });
    assert.equal(r.started, true);
    assert.equal(r.ok, true);
    assert.equal(r.version, "2.3.573");
    assert.equal(seen[0].auth, "Bearer cicy_tok");
    assert.deepEqual(seen[0].body, { target: "2.3.573", registry: "https://registry.npmmirror.com" });
  } finally { srv.close(); }
});

test("inAppUpdate reports not-started so the caller can fall back", async () => {
  const { srv, port } = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ started: false, error: "updater not found: /usr/local/bin/cicy-code-update.sh" }));
  });
  try {
    const r = await inAppUpdate({ port, token: "t", target: "2.3.573" });
    assert.equal(r.started, false);
    assert.match(r.reason, /updater not found/);
  } finally { srv.close(); }
  const unreachable = await inAppUpdate({ port: 1, token: "t", target: "2.3.573" });
  assert.equal(unreachable.started, false);
  assert.match(unreachable.reason, /api_unreachable/);
  assert.equal((await inAppUpdate({ port, token: "", target: "x" })).reason, "no_token");
});

test("inAppUpdate treats 'already up to date' as success", async () => {
  const { srv, port } = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ started: false, current: "2.3.573", latest: "2.3.573", error: "already up to date" }));
  });
  try {
    const r = await inAppUpdate({ port, token: "t", target: "2.3.573" });
    assert.equal(r.started, true); assert.equal(r.ok, true); assert.equal(r.alreadyLatest, true);
  } finally { srv.close(); }
});
