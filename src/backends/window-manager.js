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

const LOCAL_PORT = Number(process.env.CICY_CODE_PORT || (process.platform === "win32" ? 8007 : 8008));
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
  // STEP 1 — Docker mode (preferred on every platform): cicy-code runs
  // inside a container named "cicy", so its global.json (the SOURCE OF
  // TRUTH for the cicy-code web UI token) lives in the container, NOT
  // on the host. Critically: the host's ~/cicy-ai/global.json contains
  // a DIFFERENT token — cicy-desktop's own master token, which cicy-code
  // does NOT accept. We must read the container token FIRST and only
  // fall back when no container is running.
  try {
    const { execFileSync } = require("child_process");
    // Probe common docker CLI locations across platforms. Electron GUI
    // apps don't always inherit the same PATH as the user's shell.
    const dockerBins = process.platform === "win32"
      ? [
          "docker.exe",
          "docker",
          "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
          "C:\\Program Files\\Docker\\Docker\\resources\\docker.exe",
        ]
      : [
          "docker",
          "/usr/local/bin/docker",
          "/opt/homebrew/bin/docker",
          "/Applications/Docker.app/Contents/Resources/bin/docker",
        ];
    let raw = "";
    for (const bin of dockerBins) {
      try {
        raw = execFileSync(bin, ["exec", "cicy", "cat", "/home/cicy/cicy-ai/global.json"],
          { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (raw) break;
      } catch {}
    }
    if (raw) {
      const data = JSON.parse(raw);
      const t = typeof data.api_token === "string" ? data.api_token : "";
      if (t) return t;
    }
  } catch {}

  // STEP 2 — WSL fallback (Windows legacy): pre-Docker installs ran
  // cicy-code natively inside a WSL2 distro. Read its global.json via
  // \\wsl$\<distro>\home\<user>\cicy-ai\global.json.
  if (process.platform === "win32") {
    try {
      const { execFileSync } = require("child_process");
      const wslPath = execFileSync(
        "wsl.exe", ["-e", "bash", "-c", "echo $HOME/cicy-ai/global.json"],
        { encoding: "utf8", timeout: 3000 }
      ).trim();
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

  // STEP 3 — Host-filesystem fallback: covers native installs (cicy-code
  // daemon running directly on the host as the same or a different user),
  // or pre-Docker deployments. May return cicy-desktop's own master
  // token on Docker setups where the container isn't reachable — that's
  // wrong for the cicy-code web UI but is the best we can do.
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
  const acct = 0; // all teams open as tabs in profile 0's tab window (主人令)
  // Open as a TAB in profile 0's tab window (不弹新窗口). trusted=true so the
  // cicy-code SPA gets its electronRPC bridge. Fallback to a real window on any
  // failure so opening a backend is never blocked.
  try {
    const tabBrowser = require("../tools/tab-browser-tools");
    const { BrowserWindow } = require("electron");
    // tab name = the backend/team's title (not the SPA's document.title)
    const r = await tabBrowser.openTab(acct, url, { trusted: true, systemOpen: true, title: backend.name || "" });
    return BrowserWindow.fromId(r.winId) || createWindow({ url }, acct, true);
  } catch (e) {
    return createWindow({ url }, acct, true);
  }
}

module.exports = { openWindowForBackend, buildLocalUrl, buildRemoteUrl, resolveBackendUrl, readCicyAiApiToken, backendAccountIdx };
