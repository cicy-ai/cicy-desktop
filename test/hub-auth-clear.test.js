const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "backends", "hub-client.js"), "utf8");

test("hub-client only signs out on a hub-issued 401 for the token still on disk", () => {
  assert.match(src, /function hubRejected\(res\)[\s\S]*?res\.json\.error === "unauthorized"/);
  assert.match(src, /c\.hubAuth\.token !== token\) \{\s*cleared = false;/);
  assert.doesNotMatch(src, /res\.status === 401 && !viaSidecar\) \{\s*clearAuth\(\);/);
  assert.match(src, /log\.warn\(`\[hub\] signed out: \$\{reason\}`\)/);
});
