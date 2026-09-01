// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The self-updater used to read BOTH the version pointer and the installer from
// R2 only ("彻底不碰 GitHub"). That made auto-update fail closed on every node
// that cannot reach r2.deepfetch.de5.net — a real slice of the fleet answers
// ECONNRESET there while GitHub responds in ~300ms, so those boxes sat on an old
// version until someone pushed a package by hand. R2 stays FIRST (a private repo
// must keep working); GitHub is the fallback.
//
// app-updater requires electron at load time, so this asserts on source shape —
// the same convention as app-updater-auto.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "app-updater.js"), "utf8");

test("version pointer falls back to the GitHub release when R2 is unreachable", () => {
  assert.match(src, /function fetchLatestVersionFromGitHub\(\)/);
  assert.match(src, /api\.github\.com\/repos\/\$\{GH_REPO\}\/releases\/latest/);
  assert.match(src, /tag_name/);
  // R2 first, GitHub only in the catch — not the other way round.
  const fn = src.slice(
    src.indexOf("async function fetchLatestVersion()"),
    src.indexOf("// ── 安装包来源")
  );
  assert.match(fn, /R2_RELEASES_BASE\}\/\$\{file\}/);
  assert.match(fn, /catch \(e\) \{[^]*fetchLatestVersionFromGitHub\(\)/);
  assert.ok(
    fn.indexOf("R2_RELEASES_BASE") < fn.indexOf("fetchLatestVersionFromGitHub"),
    "R2 must be tried first"
  );
});

test("assetFor returns ordered candidates: R2 → GitHub → mirrors", () => {
  const fn = src.slice(
    src.indexOf("function assetFor(version)"),
    src.indexOf("async function firstReachable")
  );
  assert.match(
    fn,
    /const urls = \[`\$\{R2_RELEASES_BASE\}\/\$\{file\}`, \.\.\.buildUrlList\(ghUrl, "global"\)\]/
  );
  // Windows is the one platform whose asset is named differently on each source:
  // R2 keeps the CI's versioned copy, GitHub has electron-builder's Setup exe.
  assert.match(fn, /ghName = plat === "win32" \? `CiCy-Desktop-Setup-\$\{version\}\.exe` : file/);
  assert.match(fn, /releases\/download\/v\$\{version\}\/\$\{ghName\}/);
  assert.match(fn, /return \{ file, urls, url: urls\[0\] \}/);
});

test("check() probes every candidate before declaring the package missing", () => {
  assert.match(src, /async function firstReachable\(urls\)/);
  assert.match(src, /for \(const u of urls\) \{[^]*if \(await headOk\(u\)\) return u;/);
  const chk = src.slice(
    src.indexOf("async function check()"),
    src.indexOf("async function downloadUpdate()")
  );
  assert.match(chk, /const \{ urls \} = assetFor\(latest\)/);
  assert.match(chk, /const ready = await firstReachable\(urls\)/);
  assert.doesNotMatch(chk, /await headOk\(url\)/); // the old single-source probe is gone
});

test("downloadUpdate() retries the next source instead of failing on the first", () => {
  const dl = src.slice(
    src.indexOf("async function downloadUpdate()"),
    src.indexOf("function installNow()")
  );
  assert.match(dl, /const \{ urls, file \} = assetFor\(version\)/);
  assert.match(dl, /for \(const url of urls\) \{/);
  assert.match(dl, /catch \(e\) \{[^]*lastErr = e/);
  assert.match(dl, /throw lastErr \|\| new Error\("no source available"\)/);
});

test("mirrors helper is imported so CN keeps its ghproxy fallback", () => {
  assert.match(
    src,
    /const \{ R2_RELEASES_BASE, buildUrlList \} = require\("\.\/sidecar\/mirrors"\)/
  );
});
