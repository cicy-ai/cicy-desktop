const test = require("node:test");
const assert = require("node:assert");

// scripts/r2.mjs is ESM and runs main() on load; pull just the exported helper.
async function load() { const m = await import("../scripts/r2.mjs"); return m.shellQuote; }

test("shellQuote: Windows paths with spaces are quoted for cmd.exe re-parsing", async () => {
  const q = await load();
  assert.strictEqual(q("CiCy Desktop Setup 2.1.324.exe", "win32"), '"CiCy Desktop Setup 2.1.324.exe"');
  assert.strictEqual(q("releases/win/CiCy-Desktop-Setup-2.1.324.exe", "win32"), "releases/win/CiCy-Desktop-Setup-2.1.324.exe");
  assert.strictEqual(q('a "b" c', "win32"), '"a \\"b\\" c"');
  assert.strictEqual(q("CiCy Desktop Setup 2.1.324.exe", "linux"), "CiCy Desktop Setup 2.1.324.exe");
});
