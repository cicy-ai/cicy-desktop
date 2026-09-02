// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// One https.get with a 30s socket timeout used to BE the download, so a single
// stall failed the update for good. Observed in production: a node logged
// "download failed: timeout" every 30 minutes across several releases while its
// link served byte ranges from the same CDN perfectly well — it just could not
// carry 125MB inside one socket. The download now retries and resumes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "app-updater.js"), "utf8");
const once = src.slice(
  src.indexOf("function downloadOnce"),
  src.indexOf("const DOWNLOAD_ATTEMPTS")
);
const outer = src.slice(
  src.indexOf("async function download(url, dest, onProgress)"),
  src.indexOf("// ── 状态机")
);

test("a resumed request asks for the missing range and appends", () => {
  assert.match(once, /if \(startAt > 0\) headers\.Range = `bytes=\$\{startAt\}-`/);
  assert.match(once, /const resuming = res\.statusCode === 206/);
  assert.match(once, /fs\.createWriteStream\(dest, resuming \? \{ flags: "a" \} : \{\}\)/);
});

test("a server that ignores Range restarts the file instead of corrupting it", () => {
  // 200 + startAt means the body is the WHOLE file; appending it after a partial
  // would produce a longer, broken installer that still "downloads fine".
  assert.match(once, /const base = resuming \? startAt : 0/);
  assert.match(once, /const total = base \+ len/); // progress counts what is already on disk
  assert.match(once, /if \(res\.statusCode !== 200 && !resuming\)/);
});

test("progress and completion are judged against the real total", () => {
  assert.match(once, /resolve\(\{ transferred, total \}\)/);
  // A truncated body ends the stream cleanly, so finishing early must not count.
  assert.match(outer, /if \(!r\.total \|\| r\.transferred >= r\.total\) return/);
  assert.match(outer, /short read \$\{r\.transferred\}\/\$\{r\.total\}/);
});

test("retries resume from disk, and give up only when nothing moves", () => {
  assert.match(outer, /for \(let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt\+\+\)/);
  assert.match(outer, /have = fs\.statSync\(dest\)\.size/);
  assert.match(outer, /downloadOnce\(url, dest, onProgress, have\)/);
  assert.match(outer, /if \(now <= have && attempt > 1\)/); // no progress twice → drop the partial
  assert.match(src, /DOWNLOAD_ATTEMPTS = 6/);
});

test("switching source discards the partial rather than appending across hosts", () => {
  const dl = src.slice(
    src.indexOf("async function downloadUpdate"),
    src.indexOf("function installNow")
  );
  const loop = dl.slice(dl.indexOf("for (const url of urls)"));
  assert.match(loop, /fs\.unlinkSync\(dest\)/);
  assert.ok(
    loop.indexOf("fs.unlinkSync(dest)") < loop.indexOf("await download(url, dest"),
    "the partial must be cleared BEFORE the next source starts"
  );
});
