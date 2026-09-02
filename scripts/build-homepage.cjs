#!/usr/bin/env node
// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for producing the SHIPPED homepage.
//
// The app loads src/backends/homepage-react/ (a prebuilt SPA snapshot). The
// SOURCE lives in workers/render/. These are two different things and WILL
// drift apart unless the snapshot is rebuilt from source — which is exactly
// how a stale homepage (missing the version badge) shipped before.
//
// This script rebuilds the snapshot from source. It is wired into every
// release path via npm lifecycle hooks (prebuild:win/mac/linux + prepublishOnly),
// so the shipped homepage can NEVER lag behind workers/render — locally or in CI.
// Cross-platform (pure node fs/cp): runs on the maintainer's Windows box too.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RENDER = path.join(ROOT, "workers", "render");
const DIST = path.join(RENDER, "dist");
const DEST = path.join(ROOT, "src", "backends", "homepage-react");

function run(cmd, cwd) {
  console.log(`[build-homepage] $ ${cmd}  (in ${path.relative(ROOT, cwd) || "."})`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// 0) panel pages: src/tabbrowser is the SINGLE SOURCE. cicyui://panel now
//    fetches them from the Worker (newtab-protocol) with the bundled copy as
//    the fallback, so the Worker needs its own copy — generated here, never
//    hand-maintained. Two hand-kept copies is exactly how the stale homepage
//    shipped before; this one is regenerated on every build and gitignored.
const PANEL_SRC = path.join(ROOT, "src", "tabbrowser");
const PANEL_OUT = path.join(RENDER, "public", "panel");
const PANEL_PAGES = [
  "telegram-matrix.html",
  "redroid-matrix.html",
  "facebook-matrix.html",
  "split-panel.html",
];
fs.rmSync(PANEL_OUT, { recursive: true, force: true });
fs.mkdirSync(PANEL_OUT, { recursive: true });
for (const page of PANEL_PAGES) {
  fs.copyFileSync(path.join(PANEL_SRC, page), path.join(PANEL_OUT, page));
}
console.log(`[build-homepage] panel pages synced: ${PANEL_PAGES.join(", ")}`);

// 1) build the SPA from source (install deps on a cold runner)
if (!fs.existsSync(path.join(RENDER, "node_modules"))) {
  run("npm install --no-audit --no-fund", RENDER);
}
run("npm run build", RENDER);

// 2) replace the shipped snapshot with the fresh build (clean, not merge —
//    so old hashed assets don't pile up)
fs.rmSync(path.join(DEST, "assets"), { recursive: true, force: true });
fs.rmSync(path.join(DEST, "index.html"), { force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.cpSync(DIST, DEST, { recursive: true });

// 3) report which bundle shipped (visible in CI logs)
const html = fs.readFileSync(path.join(DEST, "index.html"), "utf8");
const m = html.match(/assets\/index-[A-Za-z0-9_-]*\.js/);
console.log(`[build-homepage] shipped bundle: ${m ? m[0] : "(hash not found!)"}`);
