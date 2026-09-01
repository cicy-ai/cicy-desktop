// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Regression cover for the exec_shell deadlock fix + owner-hub auto-trust.
// Pure source-shape assertions (rpc-guard/main require electron at load time, so
// they can't be exercised under plain `node --test`) PLUS a real behavioural test
// of hub-trust's suffix-locked host matcher, the security-critical piece.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("main.js: non-blocking danger calls poll instead of deadlocking on the modal", () => {
  const src = read("src/main.js");
  // The danger gate must branch on nonBlockingAuth and return the PENDING
  // sentinel for an undecided owner — never sit on a blocking ensureRpcGrant,
  // which on an unattended fleet node is the wait_ack-timeout deadlock.
  const block = src.slice(src.indexOf("if (danger) {"), src.indexOf("if (danger) {") + 1400);
  assert.match(block, /if \(nonBlockingAuth\)/);
  assert.match(block, /grantDecision\(event, toolName\)/);
  assert.match(block, /startGrantModal\(event, toolName, args\)/);
  assert.match(block, /return AUTH_PENDING_RESULT/);
  assert.match(block, /ensureRpcGrant\(event, toolName, args\)/); // blocking path kept for in-page callers
});

test("rpc-guard: danger gate dedups the consent modal per webContents", () => {
  const src = read("src/utils/rpc-guard.js");
  assert.match(src, /_pendingGrantByWc/);
  assert.match(
    src,
    /if \(_pendingGrantByWc\.has\(wc\.id\)\) return _pendingGrantByWc\.get\(wc\.id\)/
  );
});

test("rpc-guard: owner-hub origin short-circuits both the origin and danger gates", () => {
  const src = read("src/utils/rpc-guard.js");
  assert.match(src, /const hubTrust = require\("\.\/hub-trust"\)/);
  // danger gate (grantDecision) and origin gate (originDecision) both honour it
  assert.equal((src.match(/hubTrust\.isOwnerHubOrigin\(/g) || []).length >= 2, true);
});

test("rpc-guard: trust decisions key on the sender FRAME, not the top-frame URL", () => {
  const src = read("src/utils/rpc-guard.js");
  // frameUrl reads the actual originating frame (event.senderFrame) — a subframe
  // (third-party embed / injected iframe) must NOT inherit the top page's trust,
  // or the owner-hub origin gives it zero-click exec_* (RCE).
  assert.match(src, /function frameUrl\(event\)/);
  assert.match(src, /event\.senderFrame/);
  const grant = src.slice(
    src.indexOf("function grantDecision"),
    src.indexOf("function grantDecision") + 700
  );
  assert.match(grant, /const url = frameUrl\(event\)/);
  assert.match(grant, /isOwnerHubOrigin\(url\)/); // owner check uses the frame url
  assert.doesNotMatch(grant, /isOwnerHubOrigin\(wc\.getURL\(\)\)/); // never the top frame
  const origin = src.slice(
    src.indexOf("function originDecision"),
    src.indexOf("function originDecision") + 500
  );
  assert.match(origin, /const url = frameUrl\(event\)/);
});

test("rpc-guard: 允许一次 is recorded so the polling transport's retry gets through", () => {
  const src = read("src/utils/rpc-guard.js");
  assert.match(src, /_grantOnceByWc/);
  // grantDecision honours the short-lived record; _runGrantModal writes it on 允许一次.
  assert.match(src, /_grantOnceByWc\.get\(wc\.id\)/);
  assert.match(src, /_grantOnceByWc\.set\(wc\.id, \{ origin, at: Date\.now\(\) \}\)/);
});

test("hub-client records the owner hub host on a grant and clears it on logout", () => {
  const src = read("src/backends/hub-client.js");
  assert.match(src, /hubTrust\.recordOwnerHubHost\(res\.json\.host\)/);
  const clearAuth = src.slice(
    src.indexOf("function clearAuth"),
    src.indexOf("function clearAuth") + 260
  );
  assert.match(clearAuth, /hubTrust\.clearOwnerHubHost\(\)/);
});

test("hub-trust: owner host is suffix-locked to <tenant>.hub.cicy-ai.com", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-hubtrust-"));
  const prevHome = process.env.HOME,
    prevUp = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, "cicy-ai"), { recursive: true });
  delete require.cache[require.resolve("../src/utils/hub-trust")];
  delete require.cache[require.resolve("../src/utils/global-json")];
  try {
    const t = require("../src/utils/hub-trust");
    // normHubHost rejects everything but an exact single-label tenant hub host
    assert.equal(
      t.normHubHost("https://limeng.hub.cicy-ai.com/#/project/3"),
      "limeng.hub.cicy-ai.com"
    );
    assert.equal(t.normHubHost("hub.cicy-ai.com"), ""); // bare suffix
    assert.equal(t.normHubHost("a.b.hub.cicy-ai.com"), ""); // nested
    assert.equal(t.normHubHost("evil.hub.cicy-ai.com.attacker.com"), ""); // fake suffix
    assert.equal(t.normHubHost("r2.deepfetch.de5.net"), ""); // unrelated

    // Not logged in → never trusts, even a well-formed host.
    const gj = require("../src/utils/global-json");
    gj.updateGlobalConfig(path.join(home, "cicy-ai", "global.json"), (c) => c);
    assert.equal(t.isOwnerHubOrigin("https://limeng.hub.cicy-ai.com/x"), false);

    // Logged in + recorded host → trusts that host only.
    gj.updateGlobalConfig(path.join(home, "cicy-ai", "global.json"), (c) => {
      c.hubAuth = { token: "tk", owner: "limeng9088@gmail.com" };
      return c;
    });
    assert.equal(t.recordOwnerHubHost("https://limeng.hub.cicy-ai.com/").ok, true);
    assert.equal(t.isOwnerHubOrigin("https://limeng.hub.cicy-ai.com/#/project/9"), true);
    assert.equal(t.isOwnerHubOrigin("https://other.hub.cicy-ai.com/"), false); // different tenant
    assert.equal(t.recordOwnerHubHost("hub.cicy-ai.com").ok, false); // can't record bare suffix

    // Logout clears trust.
    t.clearOwnerHubHost();
    assert.equal(t.isOwnerHubOrigin("https://limeng.hub.cicy-ai.com/"), false);
  } finally {
    process.env.HOME = prevHome;
    if (prevUp === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUp;
    delete require.cache[require.resolve("../src/utils/hub-trust")];
    delete require.cache[require.resolve("../src/utils/global-json")];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("hub_open_team tool is registered on profile 0 with owner-hub guarding", () => {
  const reg = require("../src/tools/hub-team-tools");
  let cap = null;
  reg((name, desc, schema, handler, opts) => {
    if (name === "hub_open_team") cap = { name, schema, opts, handler };
  });
  assert.ok(cap, "hub_open_team registered");
  assert.equal(cap.opts.tag, "System");
  assert.equal(typeof cap.handler, "function");
  assert.deepEqual(cap.schema.parse({ project: "default" }), { project: "default" });
  const src = read("src/tools/hub-team-tools.js");
  assert.match(src, /openTab\(0,/g ? /openTab\(0,/ : /openTab/); // always profile 0
  assert.match(src, /isOwnerHubOrigin\(args\.url\)/); // exact-url mode stays inside owner origin
});
