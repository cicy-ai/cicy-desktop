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
      const { execFile } = require("child_process");
      const port = 8008;

      // ── Download and replace binary ───────────────────────────────────────
      // Do NOT unconditionally stop the daemon before downloading.
      // If it's owned by another OS user we can't kill it, and the binary
      // replacement still works on Unix (unlink old inode, rename new file).
      const final = await installer.install({ onProgress: broadcast });

      // ── Restart the daemon so the new binary takes effect ────────────────
      // Platform-specific because the kill primitive differs:
      //   Windows: cicy-code lives inside WSL → wsl.stop() does pkill in distro
      //   macOS/Linux: lsof + SIGKILL on the listening process (skip if EPERM)
      let restartedPid = null;

      if (process.platform === "win32") {
        try {
          const wsl = require("../sidecar/wsl");
          await wsl.stop();
          await new Promise(r => setTimeout(r, 500));
          const ch = await sidecar.start({ logPath: sidecarLogPath, force: true });
          if (ch?.pid) restartedPid = ch.pid;
        } catch (e) { log.warn(`[sidecar-ipc] win32 restart failed: ${e.message}`); }

        const reply = { ok: true, ...final, restartedPid };
        broadcast({ ...final, restartedPid });
        return reply;
      }

      // Find the PID *listening* on :8008 (not clients connecting to it).
      // Without -sTCP:LISTEN, lsof also returns processes that have open
      // connections TO port 8008 — including cicy-desktop's own health
      // probe connections — which would cause us to kill ourselves.
      const portPid = await new Promise(resolve => {
        execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], (_, out) => {
          const pid = parseInt((out || "").trim().split("\n")[0], 10);
          resolve(isNaN(pid) ? null : pid);
        });
      });

      if (portPid) {
        const canKill = await new Promise(resolve => {
          try { process.kill(portPid, 9); resolve(true); }
          catch { resolve(false); } // EPERM: externally managed
        });
        if (canKill) {
          await new Promise(r => setTimeout(r, 800));
          try {
            const ch = await sidecar.start({ logPath: sidecarLogPath, force: true });
            if (ch?.pid) restartedPid = ch.pid;
          } catch (e) { log.warn(`[sidecar-ipc] restart failed: ${e.message}`); }
        } else {
          log.info(`[sidecar-ipc] :${port} is externally managed (pid ${portPid}) — binary updated, restart externally to activate`);
        }
      } else {
        // Nothing on :8008 — just start fresh
        try {
          const ch = await sidecar.start({ logPath: sidecarLogPath, force: true });
          if (ch?.pid) restartedPid = ch.pid;
        } catch (e) { log.warn(`[sidecar-ipc] start failed: ${e.message}`); }
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
