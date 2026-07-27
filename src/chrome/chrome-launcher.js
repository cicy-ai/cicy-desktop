// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { isPortOpen } = require("../utils/process-utils");
const { waitForDebugger, getVersion } = require("./chrome-cdp-client");

const { config } = require("../config");

// Default profile model: one user-data-dir per accountIdx
// Directory layout:
//   ~/chrome/profile_<idx>/Default/...
const DEFAULT_USER_DATA_BASE_ROOT = path.join(os.homedir(), "chrome");
const DEFAULT_DEBUGGER_BASE_PORT = 9320;

function getProfileDirectory(_accountIdx) {
  return "Default";
}

function getDefaultUserDataDirRoot(accountIdx, baseRoot = DEFAULT_USER_DATA_BASE_ROOT) {
  // If caller passes a concrete profile dir already, respect it.
  // (account_<n> accepted for backward-compat with pre-rename dirs.)
  if (typeof baseRoot === "string" && /(?:profile|account)_\d+$/.test(baseRoot)) {
    return baseRoot;
  }
  return path.join(baseRoot, `profile_${accountIdx}`);
}

function getDefaultDebuggerPort(accountIdx, basePort = DEFAULT_DEBUGGER_BASE_PORT) {
  const effectiveBasePort =
    typeof basePort === "number"
      ? basePort
      : typeof config.chromeDebuggerBasePort === "number"
        ? config.chromeDebuggerBasePort
        : DEFAULT_DEBUGGER_BASE_PORT;

  return effectiveBasePort + accountIdx;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getBinaryCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ];
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env["PROGRAMFILES(X86)"];
    return [
      // ONLY standard / official Chrome install layouts. Repackaged "green"
      // Chrome (common in CN, installs under …\Google\Chrome\Bin\, doesn't
      // register App Paths) is deliberately NOT probed: those builds launch and
      // immediately exit without opening --remote-debugging-port, so a profile
      // can never attach. Better to report "not installed" and prompt the user to
      // install official Chrome than to pick a Chrome we can't drive.
      localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      programFiles && path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      programFilesX86 && path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      localAppData && path.join(localAppData, "Chromium", "Application", "chrome.exe"),
      programFiles && path.join(programFiles, "Chromium", "Application", "chrome.exe"),
      programFilesX86 && path.join(programFilesX86, "Chromium", "Application", "chrome.exe"),
    ].filter(Boolean);
  }

  return ["google-chrome", "chromium", "chromium-browser", "/usr/bin/google-chrome", "/usr/bin/chromium"];
}

function isDirectPath(binaryPath) {
  return binaryPath.includes(path.sep) || (process.platform === "win32" && /^[a-zA-Z]:\\/.test(binaryPath));
}

// Windows: Chrome registers its exact install path under "App Paths" on install,
// independent of where it landed (per-user vs per-machine, custom drive). This is
// far more reliable than the %ProgramFiles% guesses — those miss per-user installs
// and break when the launching process runs with a stripped env (e.g. the
// StartElectron scheduled task), which is why an installed Chrome can still read
// as "not found".
function queryWindowsChromeFromRegistry() {
  if (process.platform !== "win32") return null;
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
  ];
  for (const key of keys) {
    try {
      const out = execFileSync("reg", ["query", key, "/ve"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      const m = out.match(/REG_SZ\s+(.+?\.exe)\s*$/im);
      if (m && fs.existsSync(m[1].trim())) return m[1].trim();
    } catch (_) {}
  }
  return null;
}

// PATH lookup for a bare command — `where` on Windows, `which` on posix. Returns
// the first existing match, else null.
function whichBinary(cmd) {
  try {
    const tool = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(tool, [cmd], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return null;
}

function resolveChromeBinary(binaryPath) {
  // 1) Explicit override (config.chromeBinary / --chrome-binary) that exists.
  if (binaryPath && isDirectPath(binaryPath) && fs.existsSync(binaryPath)) return binaryPath;

  // 2) Windows registry App Paths — authoritative, install-location independent.
  const regPath = queryWindowsChromeFromRegistry();
  if (regPath) return regPath;

  // 3) Platform candidates: concrete paths checked for existence; bare commands
  //    resolved via PATH (where/which) so we only accept a Chrome that's actually
  //    present.
  const candidates = [binaryPath, ...getBinaryCandidates()].filter(Boolean);
  const bareCommands = [];
  for (const candidate of candidates) {
    if (isDirectPath(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      bareCommands.push(candidate);
      const resolved = whichBinary(candidate);
      if (resolved) return resolved;
    }
  }

  // 4) Name-based last resort.
  const byName =
    whichBinary(process.platform === "win32" ? "chrome" : "google-chrome") ||
    whichBinary(process.platform === "win32" ? "chrome.exe" : "chromium");
  if (byName) return byName;

  // 5) Nothing concrete found. On posix, let spawn try the first bare command
  //    (covers exotic PATH setups where `which` itself isn't available); on
  //    Windows everything is a concrete path, so fail with a clear message.
  if (bareCommands.length) return bareCommands[0];

  throw new Error(
    "Chrome/Chromium binary not found. Please configure chromeBinary or --chrome-binary."
  );
}

function buildChromeArgs({ userDataDirRoot, profileDirectory, debuggerPort, proxy, url }) {
  const args = [
    `--user-data-dir=${userDataDirRoot}`,
    `--profile-directory=${profileDirectory}`,
    `--remote-debugging-port=${debuggerPort}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
  ];

  if (proxy) {
    args.push(`--proxy-server=${proxy}`);
  }

  if (url) {
    args.push(url);
  }

  return args;
}

async function ensurePortAvailable(debuggerPort) {
  const open = await isPortOpen(debuggerPort, "127.0.0.1", 500);
  if (open) {
    try {
      const version = await getVersion(debuggerPort, "127.0.0.1");
      throw new Error(
        `Debugger port ${debuggerPort} is already in use by ${version.Browser || "another process"}`
      );
    } catch (error) {
      if (String(error.message || "").includes("already in use by")) {
        throw error;
      }
      throw new Error(`Debugger port ${debuggerPort} is already in use`);
    }
  }
}

async function launchChrome({
  accountIdx,
  debuggerPort,
  proxy,
  chromeBinary,
  url,
  userDataDirRoot,
  userDataBaseRoot = DEFAULT_USER_DATA_BASE_ROOT,
}) {
  const profileDirectory = getProfileDirectory(accountIdx);
  const effectiveUserDataDirRoot = userDataDirRoot || getDefaultUserDataDirRoot(accountIdx, userDataBaseRoot);

  ensureDir(effectiveUserDataDirRoot);
  ensureDir(path.join(effectiveUserDataDirRoot, profileDirectory));
  await ensurePortAvailable(debuggerPort);

  const binaryPath = resolveChromeBinary(chromeBinary);
  const args = buildChromeArgs({
    userDataDirRoot: effectiveUserDataDirRoot,
    profileDirectory,
    debuggerPort,
    proxy,
    url,
  });
  const child = spawn(binaryPath, args, {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });

  child.unref();

  const version = await waitForDebugger(debuggerPort, "127.0.0.1", 15000);
  bringChromeAppToForeground(binaryPath);

  return {
    pid: child.pid,
    debuggerPort,
    profileDirectory,
    userDataDirRoot: effectiveUserDataDirRoot,
    chromeBinary: binaryPath,
    proxy: proxy || null,
    url: url || null,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    browser: version.Browser || null,
  };
}

function closeChromeProcess(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (_) {}
}

// macOS / Windows focus-stealing prevention keeps the spawning Electron
// app on top after we launch Chrome, so the user's keystrokes go into
// Electron. Nudge the OS to bring Chrome forward without opening it again.
function bringChromeAppToForeground(binaryPath) {
  try {
    if (process.platform === "darwin") {
      let resolved = binaryPath;
      if (!resolved || !fs.existsSync(resolved)) {
        try { resolved = resolveChromeBinary(); } catch (_) { return; }
      }
      const match = resolved && resolved.match(/^(.+\.app)\//);
      if (!match) return;
      // `open -a <bundle>` sends an OPEN event. With a managed Chrome already
      // running under --user-data-dir, LaunchServices may handle that event by
      // opening the default, argument-less Chrome too — one click then produces
      // two Chrome windows. AppleScript `activate` only raises the running app.
      const appName = path.basename(match[1], ".app").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      spawn("/usr/bin/osascript", ["-e", `tell application "${appName}" to activate`], {
        stdio: "ignore",
        detached: true,
      }).unref();
      return;
    }
    if (process.platform === "win32") {
      const ps =
        "$p = Get-Process chrome -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; " +
        "if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null }";
      spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).unref();
      return;
    }
  } catch (_) {
    // best-effort; never fail the launch over a focus nudge
  }
}

module.exports = {
  DEFAULT_USER_DATA_BASE_ROOT,
  getDefaultUserDataDirRoot,
  DEFAULT_DEBUGGER_BASE_PORT,
  getProfileDirectory,
  getDefaultDebuggerPort,
  resolveChromeBinary,
  buildChromeArgs,
  launchChrome,
  closeChromeProcess,
  bringChromeAppToForeground,
};
