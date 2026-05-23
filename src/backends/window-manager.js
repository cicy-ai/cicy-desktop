// Opens BrowserWindow instances targeting a Backend. The local backend wraps
// the bundled cicy-code daemon (started + supervised by src/sidecar/cicy-code.js)
// and resolves its admin URL against ~/cicy-ai/global.json's api_token —
// this is cicy-code's own token, not cicy-desktop's MCP token, because the
// window loads cicy-code's web UI directly at http://127.0.0.1:8008.

const fs = require("fs");
const os = require("os");
const path = require("path");
const sidecar = require("../sidecar/cicy-code");
const { createWindow } = require("../utils/window-utils");
const registry = require("./registry");

const LOCAL_PORT = Number(process.env.CICY_CODE_PORT || 8008);
const LOCAL_HOST = "127.0.0.1";

// On a typical install cicy-code runs as the same user as cicy-desktop,
// so its config lives at <user-home>/cicy-ai/global.json. But on shared
// machines an externally-managed daemon may run as a different user
// (e.g. /Users/cicy-code on mac dev boxes). In that case `~/cicy-ai/...`
// of the cicy-desktop user is the *wrong* token — the cicy-code web UI
// will reject it and bounce to the login page.
//
// Strategy: find the running cicy-code binary path, derive its home from
// `<home>/bin/cicy-code`, and read that user's global.json. Fall back to
// our own user's global.json if no daemon is running yet.
function findCicyCodeDaemonHome() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("ps", ["-eo", "command"], { encoding: "utf8", timeout: 2000 });
    for (const line of out.split("\n")) {
      // Match e.g. "/Users/cicy-code/bin/cicy-code --public" or "/home/foo/bin/cicy-code"
      const m = line.match(/^([^\s]+?)\/bin\/cicy-code(?:\s|$)/);
      if (m) return m[1];
    }
  } catch {}
  return os.homedir();
}

function readCicyAiApiToken() {
  // On Windows, cicy-code runs inside WSL, so its global.json lives under
  // \\wsl$\<distro>\home\<user>\cicy-ai\global.json. Try WSL paths first.
  if (process.platform === "win32") {
    try {
      const { execFileSync } = require("child_process");
      // Ask WSL for the actual path
      const wslPath = execFileSync(
        "wsl.exe", ["-e", "bash", "-c", "echo $HOME/cicy-ai/global.json"],
        { encoding: "utf8", timeout: 3000 }
      ).trim();
      // Convert WSL path to Windows UNC: /home/cicy/... → \\wsl$\Ubuntu\home\cicy\...
      // wslpath -w gives us the Windows path directly
      const winPath = execFileSync(
        "wsl.exe", ["-e", "wslpath", "-w", wslPath],
        { encoding: "utf8", timeout: 3000 }
      ).trim();
      if (winPath) {
        const raw = fs.readFileSync(winPath, "utf8");
        const data = JSON.parse(raw);
        if (typeof data.api_token === "string" && data.api_token) return data.api_token;
      }
    } catch {}
  }
  for (const home of [findCicyCodeDaemonHome(), os.homedir()]) {
    const p = path.join(home, "cicy-ai", "global.json");
    try {
      const raw = fs.readFileSync(p, "utf8");
      const data = JSON.parse(raw);
      const t = typeof data.api_token === "string" ? data.api_token : "";
      if (t) return t;
    } catch {}
  }
  return "";
}

function buildLocalUrl() {
  const token = readCicyAiApiToken();
  const tokenQs = token ? `?token=${encodeURIComponent(token)}` : "";
  return `http://${LOCAL_HOST}:${LOCAL_PORT}/${tokenQs}`;
}

function buildRemoteUrl(backend) {
  let url = backend.url;
  if (backend.token) {
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}token=${encodeURIComponent(backend.token)}`;
  }
  return url;
}

function resolveBackendUrl(backend) {
  if (!backend) return null;
  if (backend.kind === "local") return buildLocalUrl();
  return buildRemoteUrl(backend);
}

function backendAccountIdx(backend) {
  // Each backend gets its own persist:sandbox-<idx> partition. 1000 is
  // reserved for the local sidecar; manual backends derive a stable int
  // from their uuid so the partition survives restarts. 1001..1999 range
  // avoids collision with user-managed Chrome account indices (0..N).
  if (!backend) return 1000;
  if (backend.id === "local") return 1000;
  const crypto = require("crypto");
  const h = crypto.createHash("sha256").update(String(backend.id)).digest("hex");
  return 1001 + (parseInt(h.slice(0, 8), 16) % 999);
}

async function openWindowForBackend(backend, opts = {}) {
  if (!backend) throw new Error("backend required");

  let url;
  if (backend.kind === "local") {
    // Ensure the bundled cicy-code is running before the window tries to
    // load its UI. start() is idempotent: returns null fast if a daemon is
    // already on :8008 (e.g. an externally-managed cicy-code).
    await sidecar.start({ logPath: opts.sidecarLogPath });
    url = buildLocalUrl();
  } else {
    url = buildRemoteUrl(backend);
  }

  registry.markUsed(backend.id);
  // forceNew=true so each "Open" produces a new BrowserWindow even when
  // oneWindow mode is on — the whole point of the launcher is multi-window.
  return createWindow({ url }, backendAccountIdx(backend), true);
}

module.exports = { openWindowForBackend, buildLocalUrl, buildRemoteUrl, resolveBackendUrl, readCicyAiApiToken, backendAccountIdx };
