// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function registeredHandler(root) {
  process.env.CICY_ELECTRON_INJECT_DIR = root;
  const modulePath = require.resolve("../src/tools/electron-inject-tools");
  delete require.cache[modulePath];
  let handler;
  require(modulePath)((name, _description, _schema, candidate) => {
    if (name === "electron_inject") handler = candidate;
  });
  assert.equal(typeof handler, "function");
  return handler;
}

function data(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test("electron_inject installs, reports, replaces, and uninstalls a script", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-electron-inject-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handler = registeredHandler(root);

  const firstContent = "window.first = true;\n";
  const installed = data(await handler({ operation: "install", name: "telegram.org.js", content: firstContent }));
  const target = path.join(root, "telegram.org.js");
  assert.equal(installed.path, target);
  assert.equal(installed.size, Buffer.byteLength(firstContent));
  assert.equal(installed.sha256, crypto.createHash("sha256").update(firstContent).digest("hex"));
  assert.equal(fs.readFileSync(target, "utf8"), firstContent);
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o600);

  const status = data(await handler({ operation: "status", name: "telegram.org.js" }));
  assert.equal(status.exists, true);
  assert.equal(status.sha256, installed.sha256);

  const replacement = "window.second = true;\n";
  const replaced = data(await handler({ operation: "install", name: "telegram.org.js", content: replacement }));
  assert.equal(replaced.sha256, crypto.createHash("sha256").update(replacement).digest("hex"));
  assert.equal(fs.readFileSync(target, "utf8"), replacement);

  const removed = data(await handler({ operation: "uninstall", name: "telegram.org.js" }));
  assert.equal(removed.existed, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(data(await handler({ operation: "status", name: "telegram.org.js" })).exists, false);
});

test("electron_inject rejects unsafe names, symlinks, and oversized content", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-electron-inject-safe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handler = registeredHandler(root);

  for (const name of ["../telegram.org.js", "nested/telegram.org.js", "telegram.org.txt", ".hidden.js", "Telegram.js"]) {
    const result = await handler({ operation: "install", name, content: "x" });
    assert.equal(result.isError, true, name);
  }

  const outside = path.join(os.tmpdir(), `outside-${process.pid}.js`);
  fs.writeFileSync(outside, "outside");
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(root, "linked.js"));
  assert.equal((await handler({ operation: "install", name: "linked.js", content: "x" })).isError, true);
  assert.equal((await handler({ operation: "status", name: "linked.js" })).isError, true);
  assert.equal((await handler({ operation: "install", name: "large.js", content: "x".repeat(1024 * 1024 + 1) })).isError, true);
});
