const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// webview-preload.js runs in sandboxed renderers where only Electron built-ins
// can be required; any relative require silently kills the whole preload.
test("webview-preload only requires electron (sandboxed preload)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "backends", "webview-preload.js"), "utf8");
  const requires = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.ok(requires.length > 0);
  for (const r of requires) assert.equal(r, "electron", `unexpected require("${r}") in sandboxed preload`);
  assert.ok(src.includes("function resolveReportedCicyTheme("), "theme helper must be inlined");
});
