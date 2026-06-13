// Rebrand the HOST (unpackaged) Electron bundle so cicy-desktop presents as
// "CiCy Desktop" at the OS level — menu-bar app name, Cmd-Tab app switcher,
// Finder, and dock — instead of the stock "Electron".
//
// Why this is needed: cicy-desktop runs UNPACKAGED (npx / npm i -g — the
// mac/win/linux default, 主人令). An unpackaged app borrows the shared
// node_modules/electron bundle for its OS identity, so the menu-bar name and
// the app-switcher icon come from that bundle's Info.plist + electron.icns,
// NOT from app code. `app.dock.setIcon()` (see tray.js) only repaints the dock
// at runtime; it cannot touch the menu-bar name or the Cmd-Tab icon. The only
// way to fully rebrand an unpackaged app is to patch the host bundle itself.
//
// We do it idempotently at startup: set CFBundleName/CFBundleDisplayName and
// swap Resources/electron.icns for our build/icon.icns (backing up the stock
// one once). macOS reads the bundle name at launch, so the first time we change
// the name we relaunch ONCE to apply it — that path is self-terminating because
// the next run sees the name already branded and does nothing.
//
// macOS-only for now. Windows (rcedit electron.exe icon + FileDescription) is a
// follow-up: the .exe is locked while running, so it needs a copy-swap or an
// install-time step rather than a startup patch.

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const log = require("electron-log");

const BRAND = "CiCy Desktop";

// execPath = .../Electron.app/Contents/MacOS/Electron → return .../Contents
function macBundleContents() {
  const macOSDir = path.dirname(process.execPath); // .../Contents/MacOS
  const contents = path.dirname(macOSDir);         // .../Contents
  return path.basename(contents) === "Contents" ? contents : null;
}

function plistGet(plist, key) {
  try {
    return cp
      .execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" })
      .trim();
  } catch {
    return null;
  }
}
function plistSet(plist, key, val) {
  // PlistBuddy takes everything after the key as the value, spaces included,
  // so "Set :CFBundleName CiCy Desktop" sets the value to "CiCy Desktop".
  try {
    cp.execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${val}`, plist]);
    return true;
  } catch {
    return false;
  }
}

function ourIcns() {
  const p = path.join(__dirname, "..", "..", "build", "icon.icns");
  return fs.existsSync(p) ? p : null;
}

// Declare the desktop's URL schemes (cicy-desktop://, cicy://) in the borrowed
// Electron.app Info.plist so LaunchServices routes deeplinks (cicy-desktop://
// addTeam?…) to this app. An UNPACKAGED app CANNOT register a scheme at runtime
// on macOS — `setAsDefaultProtocolClient()` is a no-op unless the bundle DECLARES
// the scheme here. Idempotent: skips when our schemes are already declared.
function ensureURLSchemes(plist) {
  try {
    if (plistGet(plist, "CFBundleURLTypes:0:CFBundleURLSchemes:0") === "cicy-desktop") return false;
    const pb = (cmd) => { try { cp.execFileSync("/usr/libexec/PlistBuddy", ["-c", cmd, plist]); } catch {} };
    pb("Delete :CFBundleURLTypes");                 // clear any partial/stale block
    pb("Add :CFBundleURLTypes array");
    pb("Add :CFBundleURLTypes:0 dict");
    pb("Add :CFBundleURLTypes:0:CFBundleURLName string com.cicy.desktop");
    pb("Add :CFBundleURLTypes:0:CFBundleURLSchemes array");
    pb("Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string cicy-desktop");
    pb("Add :CFBundleURLTypes:0:CFBundleURLSchemes:1 string cicy");
    return true;
  } catch { return false; }
}

// Patch name + icon. Returns true if the bundle NAME changed (caller relaunches).
function brandMac() {
  const contents = macBundleContents();
  if (!contents) return false;
  const plist = path.join(contents, "Info.plist");
  if (!fs.existsSync(plist)) return false;
  const icnsTarget = path.join(contents, "Resources", "electron.icns");
  const src = ourIcns();

  let nameChanged = false;

  // 1) Menu-bar / switcher / Finder name. Read at launch, so a change needs a relaunch.
  if (plistGet(plist, "CFBundleName") !== BRAND) {
    plistSet(plist, "CFBundleName", BRAND);
    plistSet(plist, "CFBundleDisplayName", BRAND);
    nameChanged = true;
  }

  // 2) App-switcher / Finder / base dock icon. Compare by size as a cheap check;
  //    LaunchServices refresh below makes it visible without a relaunch.
  if (src) {
    let needIcon = true;
    try {
      needIcon =
        !fs.existsSync(icnsTarget) || fs.statSync(icnsTarget).size !== fs.statSync(src).size;
    } catch {}
    if (needIcon) {
      try {
        const bak = icnsTarget + ".electron-orig";
        if (fs.existsSync(icnsTarget) && !fs.existsSync(bak)) fs.copyFileSync(icnsTarget, bak);
        fs.copyFileSync(src, icnsTarget);
      } catch (e) {
        log.warn(`[Brand] icns swap failed: ${e.message}`);
      }
    }
  }

  // 3) Declare cicy-desktop:// / cicy:// so deeplinks route to this app (the
  //    lsregister below refreshes LaunchServices to pick it up; no relaunch).
  const urlChanged = ensureURLSchemes(plist);
  if (urlChanged) log.info("[Brand] declared URL schemes cicy-desktop:// / cicy:// in Info.plist");

  // Nudge LaunchServices / Finder / Dock to drop the cached icon + name.
  try {
    const bundle = path.dirname(contents); // .../Electron.app
    cp.execFileSync("/usr/bin/touch", [bundle]);
    cp.execFile(
      "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister",
      ["-f", bundle],
      () => {}
    );
  } catch {}

  log.info(`[Brand] host Electron bundle → ${BRAND} (nameChanged=${nameChanged})`);
  return nameChanged;
}

let __done = false;
function brandHostElectron() {
  if (__done) return;
  __done = true;
  try {
    if (process.platform !== "darwin") return; // win32 rcedit path: TODO
    const nameChanged = brandMac();
    if (nameChanged) {
      // The new menu-bar name only shows after a relaunch. Self-terminating:
      // the relaunched run sees the name already branded → no second relaunch.
      log.info("[Brand] relaunching once so the menu-bar name applies…");
      app.relaunch({ args: process.argv.slice(1) });
      app.exit(0);
    }
  } catch (e) {
    log.warn(`[Brand] failed: ${e.message}`);
  }
}

module.exports = { brandHostElectron };
