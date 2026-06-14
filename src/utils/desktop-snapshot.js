// desktop-snapshot.js
// Periodically captures the WHOLE desktop (not a window) to disk so the cloud
// (cicy-code) can fetch a recent screen preview by just reading a file — no live
// per-request capture. Fixes Windows, where the old on-demand path (server →
// exec_shell → PowerShell CopyFromScreen) returns empty under AppLocker / a
// display-less RDP session.
//
// Output (<dir> = ~/cicy-files/desktop-snapshot, override CICY_DESKTOP_SNAP_DIR):
//   <dir>/desktop.jpg   the image  (≤600px wide JPEG)
//   <dir>/desktop.b64   its base64 text  ← the cloud reads THIS (cat / type)
//
// Capture per platform (all from inside the user's session):
//   darwin → `screencapture -x -t jpg`     (in-process)
//   linux  → scrot / ImageMagick import    (in-process)
//   win32  → Electron desktopCapturer, but run in a SEPARATE `--disable-gpu`
//            child electron: an RDP session has no DXGI desktop-duplication, so
//            the in-process (GPU) capturer fails ("Duplication failed"); the GDI
//            path needs --disable-gpu. We isolate that to a child daemon so the
//            MAIN app keeps hardware acceleration. (主人令: 不禁用主 app 的 GPU。)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawn } = require("child_process");
const electron = require("electron");

const MAX_W = 600; // 主人令: 压到 600 以下宽度
const QUALITY = 60;
const DEFAULT_INTERVAL_MS = 8000;

function snapDir() {
  const fromEnv = (process.env.CICY_DESKTOP_SNAP_DIR || "").trim();
  return fromEnv || path.join(os.homedir(), "cicy-files", "desktop-snapshot");
}

function intervalMs(opt) {
  const fromEnv = parseInt(process.env.CICY_DESKTOP_SNAP_INTERVAL_MS || "", 10);
  return (opt && opt.intervalMs) || (fromEnv > 0 ? fromEnv : DEFAULT_INTERVAL_MS);
}

// Grab the primary screen as a NativeImage. win32 uses desktopCapturer (only
// valid when GPU is off → run from the --disable-gpu daemon); mac/linux shell out.
async function grabScreenImage() {
  const { desktopCapturer, screen, nativeImage } = electron;
  if (process.platform === "win32") {
    const d = screen.getPrimaryDisplay();
    const sf = d.scaleFactor || 1;
    const w = Math.max(1, Math.round(d.size.width * sf));
    const h = Math.max(1, Math.round(d.size.height * sf));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: w, height: h },
    });
    if (!sources.length) throw new Error("no screen source");
    let img = sources[0].thumbnail;
    for (const s of sources) { if (!s.thumbnail.isEmpty()) { img = s.thumbnail; break; } }
    if (img.isEmpty()) throw new Error("empty screen capture (no display?)");
    return img;
  }

  const tmp = path.join(os.tmpdir(), `cicy_desktop_snap_${process.pid}.jpg`);
  try { fs.unlinkSync(tmp); } catch (_) {}
  if (process.platform === "darwin") {
    execFileSync("/usr/sbin/screencapture", ["-x", "-t", "jpg", tmp], { stdio: "ignore" });
  } else {
    const env = { ...process.env, DISPLAY: process.env.DISPLAY || ":0" };
    try { execFileSync("scrot", ["-o", tmp], { stdio: "ignore", env }); }
    catch (_) { execFileSync("import", ["-window", "root", tmp], { stdio: "ignore", env }); }
  }
  const buf = fs.readFileSync(tmp);
  try { fs.unlinkSync(tmp); } catch (_) {}
  const img = electron.nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error("empty native capture");
  return img;
}

async function captureOnce() {
  const dir = snapDir();
  fs.mkdirSync(dir, { recursive: true });
  let img = await grabScreenImage();
  if (img.getSize().width > MAX_W) {
    img = img.resize({ width: MAX_W, quality: "good" }); // width-only → keeps aspect
  }
  const jpeg = img.toJPEG(QUALITY);
  if (!jpeg || jpeg.length < 256) throw new Error("encoded jpeg too small");
  fs.writeFileSync(path.join(dir, "desktop.jpg"), jpeg);
  const b64Path = path.join(dir, "desktop.b64");
  const tmpB64 = b64Path + ".tmp";
  fs.writeFileSync(tmpB64, jpeg.toString("base64"));
  fs.renameSync(tmpB64, b64Path); // atomic swap so readers never see a partial file
  const o = img.getSize();
  return { dir, w: o.width, h: o.height, bytes: jpeg.length };
}

// ── parent (started from main.js) ─────────────────────────────────────────────
let child = null;
let timer = null;
let kickTimer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try { await captureOnce(); } catch (_) { /* keep last good file */ }
  finally { running = false; }
}

function startDesktopSnapshots(options = {}) {
  const ms = intervalMs(options);
  stopDesktopSnapshots();

  if (process.platform === "win32") {
    // Spawn ONE persistent --disable-gpu child electron that runs this file as a
    // capture daemon (GDI path, works over RDP). Main app's GPU is untouched.
    const dir = snapDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    let stdio = "ignore";
    let logFd = null;
    try { logFd = fs.openSync(path.join(dir, "daemon.log"), "a"); stdio = ["ignore", logFd, logFd]; } catch (_) {}
    child = spawn(process.execPath, ["--disable-gpu", "--disable-logging", __filename], {
      env: { ...process.env, CICY_SNAP_DAEMON: "1", CICY_DESKTOP_SNAP_INTERVAL_MS: String(ms) },
      stdio,
      windowsHide: true,
    });
    child.on("exit", () => { child = null; });
    return { dir, intervalMs: ms, maxWidth: MAX_W, mode: "win-daemon", execPath: process.execPath };
  }

  // mac / linux: in-process native capture loop (no GPU concern).
  const kick = () => { tick().catch(() => {}); };
  timer = setInterval(kick, ms);
  if (timer.unref) timer.unref();
  kickTimer = setTimeout(kick, 2500);
  if (kickTimer.unref) kickTimer.unref();
  return { dir: snapDir(), intervalMs: ms, maxWidth: MAX_W, mode: "inproc" };
}

function stopDesktopSnapshots() {
  if (timer) { clearInterval(timer); timer = null; }
  if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
  if (child) { try { child.kill(); } catch (_) {} child = null; }
}

// ── daemon mode ───────────────────────────────────────────────────────────────
// Entered when this file is the entry of `electron --disable-gpu
// desktop-snapshot.js` (Windows capture child). Detected purely via the env flag
// the parent sets — NOT require.main, which is `undefined` in Electron's main
// process. The main worker requires this module WITHOUT that env, so it's skipped
// there.
if (process.env.CICY_SNAP_DAEMON === "1") {
  const { app } = electron;
  try { app.disableHardwareAcceleration(); } catch (_) {}
  let firstOk = true;
  let lastErr = "";
  const once = async () => {
    try {
      const r = await captureOnce();
      if (firstOk) { firstOk = false; console.error("[snap-daemon] capturing → " + JSON.stringify(r)); }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (msg !== lastErr) { lastErr = msg; console.error("[snap-daemon] ERR " + msg); } // dedupe spam
    }
  };
  console.error("[snap-daemon] booting, dir=" + snapDir());
  app.whenReady().then(() => {
    once();
    const t = setInterval(once, intervalMs());
    if (t.unref) t.unref();
  });
  // No window is ever created; the interval keeps the process alive. Quit if the
  // GPU/renderer dies so we don't linger as a zombie.
  app.on("render-process-gone", () => app.quit());
}

module.exports = { startDesktopSnapshots, stopDesktopSnapshots, snapDir, captureOnce };
