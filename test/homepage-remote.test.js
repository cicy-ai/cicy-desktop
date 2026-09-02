// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The homepage URL was hardcoded to file://, so deploying the same SPA as the
// desktop-render Worker (desktop.cicy-ai.com) changed nothing on any desktop —
// the app never fetched it. It can now be pointed at the web build, but only
// deliberately: the home tab runs homepage-preload, whose bridge is the
// UNGUARDED "rpc" channel, so a remote origin there gets ungated exec_*/file_*.
// Hence opt-in + an automatic fall back to the bundled snapshot.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "backends", "homepage-window.js");
const src = fs.readFileSync(SRC, "utf8");

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-home-"));
  const prevHome = process.env.HOME,
    prevUp = process.env.USERPROFILE;
  const prevUrl = process.env.CICY_HOMEPAGE_URL;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CICY_HOMEPAGE_URL;
  fs.mkdirSync(path.join(home, "cicy-ai", "db"), { recursive: true });
  try {
    return fn(home);
  } finally {
    process.env.HOME = prevHome;
    if (prevUp === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUp;
    if (prevUrl === undefined) delete process.env.CICY_HOMEPAGE_URL;
    else process.env.CICY_HOMEPAGE_URL = prevUrl;
  }
}

// homepage-window requires electron; exercise the real pickHomepageURL by
// evaluating just that function plus the helper it depends on.
function loadPicker() {
  const start = src.indexOf("const LOCAL_INDEX");
  const end = src.indexOf("// Fall back to the bundled snapshot");
  const body = src.slice(start, end);
  const mod = { exports: {} };
  const fn = new Function(
    "require",
    "path",
    "module",
    "__dirname",
    body + "\nmodule.exports = { pickHomepageURL, LOCAL_URL, REMOTE_HOMEPAGE };"
  );
  fn(require, path, mod, path.dirname(SRC));
  return mod.exports;
}

test("defaults to the deployed web build", () => {
  withHome(() => {
    const { pickHomepageURL, REMOTE_HOMEPAGE } = loadPicker();
    assert.equal(pickHomepageURL(), REMOTE_HOMEPAGE);
    assert.equal(REMOTE_HOMEPAGE, "https://desktop.cicy-ai.com/");
  });
});

test("prefs.homepageRemote:false pins a machine to the bundled snapshot", () => {
  withHome((home) => {
    fs.writeFileSync(
      path.join(home, "cicy-ai", "db", "prefs.json"),
      JSON.stringify({ homepageRemote: false })
    );
    const { pickHomepageURL, LOCAL_URL } = loadPicker();
    assert.equal(pickHomepageURL(), LOCAL_URL);
    assert.match(pickHomepageURL(), /^file:\/\//);
  });
});

test("any value other than an explicit false stays on the web build", () => {
  withHome((home) => {
    for (const v of [true, "false", 0, null]) {
      fs.writeFileSync(
        path.join(home, "cicy-ai", "db", "prefs.json"),
        JSON.stringify({ homepageRemote: v })
      );
      const { pickHomepageURL, REMOTE_HOMEPAGE } = loadPicker();
      assert.equal(pickHomepageURL(), REMOTE_HOMEPAGE, `homepageRemote=${JSON.stringify(v)}`);
    }
  });
});

test("CICY_HOMEPAGE_URL wins over prefs and the default", () => {
  withHome((home) => {
    fs.writeFileSync(
      path.join(home, "cicy-ai", "db", "prefs.json"),
      JSON.stringify({ homepageRemote: false })
    );
    process.env.CICY_HOMEPAGE_URL = "http://127.0.0.1:5173/";
    try {
      assert.equal(loadPicker().pickHomepageURL(), "http://127.0.0.1:5173/");
    } finally {
      delete process.env.CICY_HOMEPAGE_URL;
    }
  });
});

test("a malformed prefs file keeps the default rather than throwing", () => {
  withHome((home) => {
    fs.writeFileSync(path.join(home, "cicy-ai", "db", "prefs.json"), "{ not json");
    const { pickHomepageURL, REMOTE_HOMEPAGE } = loadPicker();
    assert.equal(pickHomepageURL(), REMOTE_HOMEPAGE);
  });
});

test("a remote homepage always has a way back to the bundled snapshot", () => {
  assert.match(src, /wc\.on\("did-fail-load"/);
  assert.match(src, /setTimeout\(\(\) => toLocal\(`no load within/); // blank page that never commits
  assert.match(src, /if \(url\.startsWith\("file:\/\/"\)\) \{ settled = true; return; \}/); // never loops on local
  assert.match(src, /wireRemoteFallback\(wc\)/); // resident home tab
  assert.match(src, /wireRemoteFallback\(homepage\.webContents\)/); // standalone window
});
