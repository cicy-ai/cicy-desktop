// IPC handlers for the cicy-code sidecar installer.
// Decoupled from backends/ipc.js so the install flow has its own clear surface.
//
// Channels:
//   sidecar:status         → { userInstalled, userVersion, binaryPath, installing, lastProgress }
//   sidecar:check-latest   → { ok, latest, installedVersion, network, sizeBytes, releaseUrl, error? }
//   sidecar:install        → final progress event { phase, version?, ... }; emits sidecar:progress along the way
//   sidecar:cancel         → boolean
//
// All renderers receive the same `sidecar:progress` broadcast so the UI can
// rejoin an in-flight install after a refresh.

const { ipcMain, BrowserWindow } = require("electron");
const log = require("electron-log");
const installer = require("../sidecar/installer");
const sidecar = require("../sidecar/cicy-code");

let registered = false;
let lastProgress = null;

function broadcast(event) {
  lastProgress = event;
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send("sidecar:progress", event); } catch {}
  }
}

function register({ sidecarLogPath } = {}) {
  if (registered) return;
  registered = true;

  ipcMain.handle("sidecar:status", async () => {
    const s = installer.getStatus();
    // On Windows the version cache might be stale; probe WSL for truth.
    if (process.platform === "win32") {
      try {
        const wsl = require("../sidecar/wsl");
        const [wslStatus, wslInstalled, wslVer] = await Promise.all([
          wsl.checkStatus(),
          wsl.userInstalled(),
          wsl.userVersion(),
        ]);
        return {
          ...s,
          userInstalled: wslInstalled,
          userVersion: wslVer || s.userVersion,
          wsl: wslStatus,
          lastProgress,
        };
      } catch {}
    }
    return { ...s, lastProgress };
  });

  // Windows-only: expose WSL detection so the homepage can surface the right
  // setup card (install WSL → install distro → install cicy-code). On other
  // platforms the call is a no-op returning { supported: false }.
  ipcMain.handle("sidecar:wsl-status", async () => {
    if (process.platform !== "win32") return { supported: false };
    try {
      const wsl = require("../sidecar/wsl");
      const status = await wsl.checkStatus();
      return { supported: true, ...status };
    } catch (e) {
      return { supported: true, installed: false, error: e.message };
    }
  });

  ipcMain.handle("sidecar:check-latest", async () => installer.checkLatest());

  ipcMain.handle("sidecar:install", async () => {
    try {
      const final = await installer.install({ onProgress: broadcast });

      // ── Restart with new binary ──────────────────────────────────────────
      // Strategy: kill the process holding :8008 by PID (lsof), not by name.
      // This works if it's our process (same user). If the port belongs to an
      // external user (e.g. 'cicy-code' on a shared mac), kill will fail with
      // EPERM — in that case we leave it running; the new binary is already on
      // disk and will be used next time the external process restarts.
      const { execFile } = require("child_process");
      const port = 8008;

      const portPid = await new Promise(resolve => {
        execFile("lsof", ["-ti", `:${port}`], (err, out) => {
          const pid = parseInt((out || "").trim().split("\n")[0], 10);
          resolve(isNaN(pid) ? null : pid);
        });
      });

      let killed = false;
      if (portPid) {
        killed = await new Promise(resolve => {
          process.kill(portPid, 0); // test if it exists
          try {
            process.kill(portPid, 9);
            resolve(true);
          } catch {
            resolve(false); // EPERM — different user
          }
        });
      }

      let restartedPid = null;
      if (killed || !portPid) {
        // Port should be free, wait briefly then start new binary
        await new Promise(r => setTimeout(r, 800));
        try {
          const ch = await sidecar.start({ logPath: sidecarLogPath, force: true });
          if (ch?.pid) restartedPid = ch.pid;
        } catch (e) {
          log.warn(`[sidecar-ipc] restart failed: ${e.message}`);
        }
      } else {
        // External process we can't kill — binary replaced, takes effect on next restart
        log.warn(`[sidecar-ipc] :${port} owned by pid ${portPid} (different user) — binary updated, restart externally to apply`);
      }

      const reply = { ok: true, ...final, restartedPid };
      broadcast({ ...final, restartedPid });
      return reply;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("sidecar:cancel", () => {
    installer.cancel();
    return true;
  });
}

module.exports = { register };
