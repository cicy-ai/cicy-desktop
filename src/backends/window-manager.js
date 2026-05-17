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

function readCicyAiApiToken() {
  const p = path.join(os.homedir(), "cicy-ai", "global.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    return typeof data.api_token === "string" ? data.api_token : "";
  } catch {
    return "";
  }
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
  return createWindow({ url }, 0, true);
}

module.exports = { openWindowForBackend, buildLocalUrl, buildRemoteUrl, resolveBackendUrl, readCicyAiApiToken };
