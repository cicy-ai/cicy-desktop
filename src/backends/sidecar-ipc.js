// IPC handlers for the cicy-code sidecar.
//
// cicy-code is no longer downloaded by an in-app installer — the sidecar runs
// it via `npx cicy-code` (mac/linux) or Docker (Windows); see
// src/sidecar/cicy-code.js. So this surface is just lifecycle + status:
//   sidecar:status  → { running }   — is something answering on :8008?
//   sidecar:start   → { ok, ... }   — start (or reuse) the daemon
//   sidecar:stop    → { ok }        — stop the daemon we spawned
//   sidecar:restart → { ok, ... }   — stop + fresh spawn (same version)
//   sidecar:update  → { ok, ... }   — stop + spawn cicy-code@latest
//
// (Removed: sidecar:check-latest / install / cancel / wsl-status / wsl-install,
// along with src/sidecar/installer.js and src/sidecar/wsl.js.)

const { ipcMain } = require("electron");
const sidecar = require("../sidecar/cicy-code");

const PORT = Number(process.env.CICY_CODE_PORT || 8008);
let registered = false;

function register({ sidecarLogPath } = {}) {
  if (registered) return;
  registered = true;

  ipcMain.handle("sidecar:status", async () => {
    const running = await sidecar.probeExisting(PORT);
    return { running };
  });

  // Start (or reuse) the cicy-code daemon. probeExisting inside start() reuses
  // a healthy :8008; otherwise it spawns `npx cicy-code` / the Docker container.
  ipcMain.handle("sidecar:start", async () => {
    try {
      if (await sidecar.probeExisting(PORT)) return { ok: true, alreadyRunning: true };
      const child = await sidecar.start({ logPath: sidecarLogPath, force: false });
      // Wait briefly for it to bind :8008 so the homepage's poll flips to
      // "running" on the next tick.
      for (let i = 0; i < 20; i++) {
        if (await sidecar.probeExisting(PORT)) return { ok: true, pid: child?.pid || null };
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ok: true, pid: child?.pid || null, warning: "spawned but did not bind :8008 within 5s" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Stop the daemon we spawned. (A user-run / external instance we only
  // probed can't be killed from here — stop() no-ops when we hold no child.)
  ipcMain.handle("sidecar:stop", async () => {
    try {
      await sidecar.stop();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Restart: stop + fresh spawn (same cached version). Wait for :8008 to
  // come back so the homepage poll flips to "running".
  ipcMain.handle("sidecar:restart", async () => {
    try {
      const child = await sidecar.restart({ logPath: sidecarLogPath });
      for (let i = 0; i < 20; i++) {
        if (await sidecar.probeExisting(PORT)) return { ok: true, pid: child?.pid || null };
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ok: true, pid: child?.pid || null, warning: "restarted but did not bind :8008 within 5s" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Update: stop + spawn cicy-code@latest (or reload the Docker image on
  // win32). The npx re-resolve / image pull can take a while on a cold cache,
  // so allow a longer window for :8008 to come back.
  ipcMain.handle("sidecar:update", async () => {
    try {
      const child = await sidecar.update({ logPath: sidecarLogPath });
      for (let i = 0; i < 240; i++) {
        if (await sidecar.probeExisting(PORT)) return { ok: true, pid: child?.pid || null };
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ok: true, pid: child?.pid || null, warning: "updated but did not bind :8008 within 60s" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register };
