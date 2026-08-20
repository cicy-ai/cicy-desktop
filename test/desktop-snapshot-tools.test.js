// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("desktop_snapshot does not capture live when desktop snapshots are disabled", async (t) => {
  if (process.platform === "win32") {
    t.skip("the Windows one-shot capture path is intentionally separate");
    return;
  }

  const emptySnapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-snapshot-test-"));
  t.after(() => fs.rmSync(emptySnapshotDir, { recursive: true, force: true }));

  const snapshotPath = require.resolve("../src/utils/desktop-snapshot");
  const toolsPath = require.resolve("../src/tools/desktop-snapshot-tools");
  const originalSnapshotModule = require.cache[snapshotPath];
  const originalToolsModule = require.cache[toolsPath];
  let captureCalls = 0;

  require.cache[snapshotPath] = {
    id: snapshotPath,
    filename: snapshotPath,
    loaded: true,
    exports: {
      snapDir: () => emptySnapshotDir,
      snapshotEnabled: () => false,
      captureB64: async () => {
        captureCalls += 1;
        return { b64: "captured" };
      },
    },
  };
  delete require.cache[toolsPath];

  t.after(() => {
    if (originalSnapshotModule) require.cache[snapshotPath] = originalSnapshotModule;
    else delete require.cache[snapshotPath];
    if (originalToolsModule) require.cache[toolsPath] = originalToolsModule;
    else delete require.cache[toolsPath];
  });

  let handler;
  require(toolsPath)((name, _description, _schema, registeredHandler) => {
    if (name === "desktop_snapshot") handler = registeredHandler;
  });

  assert.equal(typeof handler, "function");
  const result = await handler({ maxWidth: 600 });

  assert.equal(captureCalls, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error:/);
});
