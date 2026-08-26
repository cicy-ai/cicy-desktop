const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Static checks: a deny must expire (cooldown) and a failed allowlist add must
// still honour the user's "trust" choice for the session and explain the error.
test("origin deny is a cooldown, not process-lifetime; failed allowlist add is explained", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "rpc-guard.js"), "utf8");
  assert.match(src, /const DENY_COOLDOWN_MS = \d+ \* 1000;/);
  assert.match(src, /const _deniedOrigins = new Map\(\)/);
  assert.match(src, /Date\.now\(\) - deniedAt < DENY_COOLDOWN_MS\) return "deny"/);
  assert.match(src, /_deniedOrigins\.set\(origin, Date\.now\(\)\)/);
  assert.match(src, /加入白名单失败/);
  const trustBranch = src.slice(src.indexOf("if (r === 2 && host)"), src.indexOf("_deniedOrigins.set(origin"));
  assert.match(trustBranch, /_sessionOrigins\.add\(origin\);[^]*return true;[^]*_sessionOrigins\.add\(origin\);[^]*return true;/);
  assert.doesNotMatch(trustBranch, /return false/);
});
