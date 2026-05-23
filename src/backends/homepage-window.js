// Homepage window — primary CiCy Desktop window. Singleton; closing it
// does NOT quit the app. The homepage is now a React SPA hosted on
// https://desktop.cicy-ai.com — this lets us iterate the UI without
// rebuilding cicy-desktop. The preload script (`window.cicy.*` API) is
// origin-agnostic and works with any URL.
//
// Override priority:
//   1. CICY_HOMEPAGE_URL env (Vite dev server, e.g. http://localhost:8173)
//   2. https://desktop.cicy-ai.com (production remote)
//   3. ./homepage-react/index.html  (offline fallback bundled at build time)
//   4. ./homepage.html              (legacy vanilla — last-resort fallback)

const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { BrowserWindow } = require("electron");
const log = require("electron-log");

const REMOTE_URL = "https://desktop.cicy-ai.com/";
const DEV_URL = process.env.CICY_HOMEPAGE_URL || "";

let homepage = null;

function pickHtml() {
  const reactBuild = path.join(__dirname, "homepage-react", "index.html");
  if (fs.existsSync(reactBuild)) return reactBuild;
  return path.join(__dirname, "homepage.html");
}

// HEAD probe — ~2s timeout. If the remote URL is reachable, we use it; if
// the user is offline, network is blocking us, or the host is down, we fall
// back to the bundled React build so the app still works.
function probeRemote(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith("https:") ? https : http;
      const req = lib.request(url, { method: "HEAD", timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

async function openHomepage() {
  if (homepage && !homepage.isDestroyed()) {
    if (homepage.isMinimized()) homepage.restore();
    homepage.show();
    homepage.focus();
    return homepage;
  }
  homepage = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 360,
    minHeight: 480,
    title: "CiCy Desktop",
    backgroundColor: "#0d1117",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "homepage-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Resolve target URL: env override > remote (if reachable) > local fallback.
  let target;
  if (DEV_URL) {
    target = { kind: "url", value: DEV_URL };
  } else {
    const remoteOk = await probeRemote(REMOTE_URL);
    if (remoteOk) {
      target = { kind: "url", value: REMOTE_URL };
    } else {
      log.warn(`[homepage] remote ${REMOTE_URL} unreachable — using bundled fallback`);
      target = { kind: "file", value: pickHtml() };
    }
  }
  log.info(`[homepage] loading ${target.kind}: ${target.value}`);
  if (target.kind === "url") homepage.loadURL(target.value);
  else                       homepage.loadFile(target.value);

  // Pipe renderer console + load failures to main-process stdout so we can
  // diagnose blank-page bugs from logs without opening DevTools.
  homepage.webContents.on("console-message", (_e, level, msg, line, source) => {
    if (level >= 1) console.log(`[homepage:console L${line}] ${msg}  (${source})`);
  });
  homepage.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[homepage] did-fail-load ${code} ${desc} ${url}`);
    // If the remote URL fails mid-flight, fall back to local bundle.
    if (target.kind === "url" && url === target.value) {
      log.warn(`[homepage] falling back to local bundle after remote failure`);
      homepage.loadFile(pickHtml());
    }
  });
  homepage.on("closed", () => { homepage = null; });
  return homepage;
}

function isOpen() {
  return !!(homepage && !homepage.isDestroyed());
}

module.exports = { openHomepage, isOpen, getHomepageWindow: () => homepage };
