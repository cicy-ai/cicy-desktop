const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { updateGlobalConfig, readGlobalConfig } = require("../src/utils/global-json");

test("updateGlobalConfig works when ~/cicy-ai does not exist yet (fresh machine)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-fresh-"));
  const file = path.join(root, "cicy-ai", "global.json"); // parent dir missing on purpose
  try {
    const next = updateGlobalConfig(file, (c) => ({ ...c, api_token: "cicy_test" }));
    assert.equal(next.api_token, "cicy_test");
    assert.equal(readGlobalConfig(file).api_token, "cicy_test");
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
