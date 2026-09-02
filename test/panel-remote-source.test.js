// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The 矩阵 / split-panel pages are served by the desktop-render Worker, so their
// UI ships by deploying rather than by releasing the app. cicyui://panel fetches
// them instead of the tab pointing at an https:// URL, which keeps the URL — and
// therefore the panel preload and the page origin — exactly as they were: only
// the HTML travels. The bundled copy under src/tabbrowser stays the fallback.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const proto = fs.readFileSync(path.join(ROOT, "src", "tabbrowser", "newtab-protocol.js"), "utf8");
const build = fs.readFileSync(path.join(ROOT, "scripts", "build-homepage.cjs"), "utf8");

test("panel HTML is fetched from the Worker, with the bundled copy as fallback", () => {
  const branch = proto.slice(
    proto.indexOf('if (host === "panel")'),
    proto.indexOf('if (host !== "newtab")')
  );
  assert.match(branch, /PANEL_REMOTE_BASE/);
  assert.match(branch, /CICY_PANEL_LOCAL !== "1"/); // escape hatch for local edits
  assert.match(branch, /AbortController/); // a hung CDN must not hang the tab
  assert.match(branch, /fs\.promises\.readFile\(file, "utf8"\)/); // fallback still reads the bundle
  assert.match(
    proto,
    /PANEL_REMOTE_BASE =\s*\n?\s*process\.env\.CICY_PANEL_BASE \|\| "https:\/\/desktop\.cicy-ai\.com\/panel"/
  );
});

test("an SPA fallback response is rejected instead of rendered as a panel", () => {
  // Workers Assets answers 200 + index.html for an unknown path; taking that
  // would silently replace the matrix with the homepage shell.
  const branch = proto.slice(
    proto.indexOf('if (host === "panel")'),
    proto.indexOf('if (host !== "newtab")')
  );
  assert.match(
    branch,
    /const spaShell = \/id="root"\/\.test\(body\) && \/assets\\\/index-\[A-Za-z0-9_-\]\+\\\.js\/\.test\(body\)/
  );
  assert.match(branch, /!spaShell/);
  // and the discriminator has to actually discriminate:
  const shell = fs.readFileSync(
    path.join(ROOT, "src", "backends", "homepage-react", "index.html"),
    "utf8"
  );
  assert.ok(
    /id="root"/.test(shell) && /assets\/index-[A-Za-z0-9_-]+\.js/.test(shell),
    "SPA shell carries both markers"
  );
  for (const p of [
    "telegram-matrix.html",
    "redroid-matrix.html",
    "facebook-matrix.html",
    "split-panel.html",
  ]) {
    const page = fs.readFileSync(path.join(ROOT, "src", "tabbrowser", p), "utf8");
    assert.ok(!/id="root"/.test(page), `${p} must not look like the SPA shell`);
  }
});

test("the Worker's copy is generated from src/tabbrowser, not hand-kept", () => {
  // Two hand-maintained copies is how a stale homepage shipped once already.
  assert.match(build, /PANEL_SRC = path\.join\(ROOT, "src", "tabbrowser"\)/);
  assert.match(build, /PANEL_OUT = path\.join\(RENDER, "public", "panel"\)/);
  assert.match(build, /fs\.rmSync\(PANEL_OUT, \{ recursive: true, force: true \}\)/); // clean, not merge
  assert.match(build, /fs\.copyFileSync\(/);
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /workers\/render\/public\/panel\//);
});
