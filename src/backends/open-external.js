// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Robust "open this URL in the system browser".
//
// electron's shell.openExternal silently fails on some Windows setups — a fresh
// user profile, a locked-down shell, or console-launched (npx) electron — leaving
// browser-login stuck ("点了没反应"). When it fails we fall back to the OS URL
// openers directly. Order matters: rundll32 / explorer / open / xdg-open take the
// URL as a SINGLE argv (no shell parsing), so the login URL's `&`/`?` query params
// survive. `cmd start` is last because cmd treats `&` as a command separator.

const { shell } = require("electron");
const { spawn } = require("child_process");
const log = require("electron-log");

function trySpawn(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (err) => log.warn(`[open-external] ${cmd} error: ${err.message}`));
    child.unref();
    return true;
  } catch (e) {
    log.warn(`[open-external] spawn ${cmd} threw: ${e.message}`);
    return false;
  }
}

// Returns true if SOME mechanism was dispatched (best-effort — the OS may still
// have no default browser, which no opener can fix; the renderer always also
// shows a copy-link fallback).
async function openExternalRobust(rawUrl) {
  const url = String(rawUrl || "");
  if (!url) return false;

  try {
    await shell.openExternal(url);
    return true;
  } catch (e) {
    log.warn(`[open-external] shell.openExternal failed, falling back: ${e && e.message}`);
  }

  if (process.platform === "win32") {
    // FileProtocolHandler + explorer pass the URL untouched (good for query strings).
    if (trySpawn("rundll32", ["url.dll,FileProtocolHandler", url])) return true;
    if (trySpawn("explorer.exe", [url])) return true;
    return trySpawn("cmd", ["/c", "start", "", url]);
  }
  if (process.platform === "darwin") return trySpawn("open", [url]);
  return trySpawn("xdg-open", [url]);
}

module.exports = { openExternalRobust };
