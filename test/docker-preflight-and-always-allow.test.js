const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("ensureWsl explains a disabled-virtualization host in the log and the card", () => {
  const src = read("src/sidecar/docker.js");
  assert.match(src, /async function virtualizationStatus\(\)/);
  const ensure = src.slice(
    src.indexOf("async function ensureWsl"),
    src.indexOf("async function bootstrap")
  );
  assert.match(ensure, /const virt = await virtualizationStatus\(\);/);
  assert.match(ensure, /reason: "virtualization_disabled"/);
  assert.match(ensure, /log\.error\(`\[bootstrap\] ✗ ensure-wsl reason=virtualization_disabled/);
  assert.match(ensure, /BIOS/);
  assert.match(
    ensure,
    /reason: storeBroken \? "windows_component_store_broken" : "wsl_enable_failed", message/
  );
  assert.match(
    read("src/sidecar/wsl-docker.js"),
    /const reason = w\.reason \|\| "wsl_enable_failed"; fail\(reason, w\.message\)/
  );
  const ipc = read("src/backends/sidecar-ipc.js");
  assert.match(ipc, /lastError: \(!s\.running && _lastBootstrapError\)/);
  assert.match(ipc, /_lastBootstrapError = \{ reason: result\.reason \|\| result\.error/);
});

test("trusted-origins: persistent dangerous-ops allow only for allowlisted hosts", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-trust-"));
  const prevHome = process.env.HOME,
    prevUp = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete require.cache[require.resolve("../src/profiles/trusted-origins-store")];
  try {
    const store = require("../src/profiles/trusted-origins-store");
    assert.equal(store.allowDangerous("xs_master.cicy-ai.com").ok, false); // not allowlisted yet
    assert.equal(store.allowDangerous("127.0.0.1").ok, true); // built-in host works too
    assert.equal(store.isDangerousAllowed("127.0.0.1"), true);
    assert.equal(store.add("xs_master.cicy-ai.com").ok, true);
    assert.equal(store.allowDangerous("https://xs_master.cicy-ai.com").ok, true);
    assert.equal(store.isDangerousAllowed("xs_master.cicy-ai.com"), true);
    assert.equal(store.add("other.example.com").ok, true); // adding another host keeps the flag
    assert.equal(store.isDangerousAllowed("xs_master.cicy-ai.com"), true);
    store.remove("xs_master.cicy-ai.com"); // removal revokes it
    assert.equal(store.isDangerousAllowed("xs_master.cicy-ai.com"), false);
  } finally {
    process.env.HOME = prevHome;
    if (prevUp === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUp;
    delete require.cache[require.resolve("../src/profiles/trusted-origins-store")];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("rpc-guard offers a persistent 'always allow' only for allowlisted origins", () => {
  const src = read("src/utils/rpc-guard.js");
  assert.match(src, /store\.isDangerousAllowed\(host\)\) return "allow"/); // grantDecision short-circuit
  assert.match(src, /store\.allowDangerous\(host\)/); // persistent grant still allowlist-only
  assert.match(src, /buttons: canAlways/); // 4th "always allow" button gated on canAlways
  assert.match(src, /此站点始终允许（不再询问）/);
  assert.match(src, /response === 3 && canAlways/);
});
