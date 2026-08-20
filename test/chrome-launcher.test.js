// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const net = require("node:net");
const test = require("node:test");

test("macOS restarts a live Chrome profile not launched by the current desktop runtime", () => {
  const { resolveLiveProfileAction } = require("../src/chrome/chrome-launcher");

  assert.equal(
    resolveLiveProfileAction({
      platform: "darwin",
      liveStatus: { isRunning: true },
      runtime: null,
      windowless: false,
    }),
    "restart-unmanaged"
  );
});

test("an unmanaged Chrome restart restores the previous browser session", () => {
  const { buildChromeArgs } = require("../src/chrome/chrome-launcher");
  const args = buildChromeArgs({
    userDataDirRoot: "/tmp/cicy-profile-1",
    profileDirectory: "Default",
    debuggerPort: 11001,
    restoreLastSession: true,
  });

  assert.ok(args.includes("--restore-last-session"));
});

test("macOS activates a reused Chrome profile by the debugger listener PID", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS-specific foreground behavior");
    return;
  }

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const calls = [];
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {} };
  };

  const launcherPath = require.resolve("../src/chrome/chrome-launcher");
  delete require.cache[launcherPath];
  const { bringChromeAppToForeground } = require(launcherPath);
  childProcess.spawn = originalSpawn;

  bringChromeAppToForeground("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", {
    debuggerPort: server.address().port,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/osascript");
  assert.deepEqual(calls[0].args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.match(
    calls[0].args[3],
    new RegExp(`runningApplicationWithProcessIdentifier\\(${process.pid}\\)`)
  );
});
