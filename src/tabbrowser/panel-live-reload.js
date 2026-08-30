// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// panel-live-reload.js — dev-time live reload for the cicyui://panel pages
// (telegram-matrix.html / redroid-matrix.html / facebook-matrix.html /
// split-panel.html). The cicyui handler already reads the page file on every
// request (newtab-protocol.js), so a plain reload picks up edits; this module
// just does the reload for you: watch src/tabbrowser/, and when a panel page
// file changes, reload every webContents currently showing that preset.
//
// On by default when running from source (app.isPackaged === false); force on
// or off with CICY_PANEL_LIVE_RELOAD=1 / 0. Main-process files are NOT
// covered — those still need an app restart.
const fs = require("fs");
const path = require("path");
const { app, webContents } = require("electron");
const { PAGES } = require("./panel-page-router");

const DIR = __dirname;
const DEBOUNCE_MS = 150;
let watcher = null;

function enabled() {
  const v = process.env.CICY_PANEL_LIVE_RELOAD;
  if (v === "1") return true;
  if (v === "0") return false;
  return !app.isPackaged;
}

// file name → presets that render it ("" = the generic split panel).
function presetsForFile(file) {
  const out = [];
  for (const [preset, page] of Object.entries(PAGES)) if (page === file) out.push(preset);
  if (file === "split-panel.html") out.push("");
  return out;
}

function presetOf(wc) {
  let u = "";
  try { u = wc.getURL(); } catch (e) { return null; }
  if (!u.startsWith("cicyui://panel")) return null;
  try { return new URL(u).searchParams.get("preset") || ""; } catch (e) { return ""; }
}

function reloadPreset(presets, log) {
  let n = 0;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    const p = presetOf(wc);
    if (p === null || !presets.includes(p)) continue;
    try { wc.reloadIgnoringCache(); n++; } catch (e) {}
  }
  return n;
}

function start(log = console) {
  if (watcher || !enabled()) return false;
  const timers = new Map();
  try {
    watcher = fs.watch(DIR, { persistent: false }, (_ev, name) => {
      if (!name) return;
      const file = path.basename(String(name));
      const presets = presetsForFile(file);
      if (!presets.length) return;
      clearTimeout(timers.get(file));
      timers.set(file, setTimeout(() => {
        timers.delete(file);
        const n = reloadPreset(presets, log);
        if (n) log.info(`[panel-live-reload] ${file} changed → reloaded ${n} panel view(s)`);
      }, DEBOUNCE_MS));
    });
    watcher.on("error", () => { stop(); });
  } catch (e) {
    watcher = null;
    return false;
  }
  log.info(`[panel-live-reload] watching ${DIR} (${Object.values(PAGES).join(", ")}, split-panel.html)`);
  return true;
}

function stop() {
  try { if (watcher) watcher.close(); } catch (e) {}
  watcher = null;
}

module.exports = { start, stop, enabled, presetsForFile, presetOf, reloadPreset };
