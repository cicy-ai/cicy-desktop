// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Auto-install kills the app by design — an installer cannot replace a running
// exe. So when an install does NOT land, the app comes back on the old version,
// the next check() tries the same thing, and the machine sits in a restart loop
// that closes the user's window every time. That is exactly what happened: the
// fleet flapped up/down until every node was gone. A destructive automatic
// action needs a stop condition, and it had none.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "app-updater.js"), "utf8");

test("the same version is not auto-installed forever", () => {
  assert.match(src, /AUTO_TRY_MAX = 2/);
  assert.match(src, /AUTO_TRY_COOLDOWN_MS = 6 \* 60 \* 60 \* 1000/);
  const fn = src.slice(src.indexOf("function autoInstallAllowed"), src.indexOf("// ── 状态机"));
  assert.match(fn, /if \(t\.version !== version\) return true/); // a new version always may
  assert.match(fn, /if \(\(t\.count \|\| 0\) < AUTO_TRY_MAX\) return true/);
  assert.match(fn, /Date\.now\(\) - \(t\.at \|\| 0\) > AUTO_TRY_COOLDOWN_MS/);
});

test("the attempt count survives the restart the install itself causes", () => {
  // In-memory state would reset on every relaunch, which is precisely the thing
  // the loop does — so the counter has to be on disk.
  assert.match(src, /desktopAutoInstall: \{ version, count, at: Date\.now\(\) \}/);
  assert.match(src, /readGlobalConfig\(GLOBAL_JSON\)\?\.desktopAutoInstall/);
});

test("check() gates the auto path and still offers the update", () => {
  const chk = src.slice(
    src.indexOf("async function check()"),
    src.indexOf("async function downloadUpdate")
  );
  assert.match(chk, /if \(!autoInstallAllowed\(latest\)\) \{/);
  assert.match(chk, /noteAutoTry\(latest\)/);
  // blocked = do not install; the "available" broadcast above still happened, so
  // the user can update by hand.
  assert.ok(
    chk.indexOf("autoInstallAllowed") < chk.indexOf("await downloadUpdate()"),
    "the gate must come before the download"
  );
});

test("a landed install clears the record", () => {
  const init = src.slice(
    src.indexOf("function init(mainWin)"),
    src.indexOf("async function check()")
  );
  assert.match(init, /readAutoTry\(\)\.version === _state\.current/);
  assert.match(init, /clearAutoTry\(\)/);
});
