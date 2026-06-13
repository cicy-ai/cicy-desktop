// window-thumbnails.js
// Periodically writes a small JPEG thumbnail of every open BrowserWindow to a
// folder — like Chrome's tab thumbnails. On-disk so the homepage / agents can
// read a recent preview of a window without an RPC + capturePage round-trip
// each time.
//
// Reuses the same capture path as `GET /ui/snapshot` (capturePage → resize →
// toJPEG), just driven on a timer and scaled to a small rect.
//
// Layout (<dir> default ~/cicy-files/window-thumbs, override CICY_THUMB_DIR):
//   <dir>/win-<id>.jpg   one small JPEG per live window (overwritten each tick)
//   <dir>/index.json     manifest: [{ id, title, url, accountIdx, w, h, file, bytes, updatedAt }]
// Thumbnails for closed windows are pruned each tick.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { BrowserWindow } = require("electron");

let timer = null;
let kickTimer = null;
let running = false; // a tick may outlast the interval — don't overlap captures

function thumbDir() {
  const fromEnv = (process.env.CICY_THUMB_DIR || "").trim();
  return fromEnv || path.join(os.homedir(), "cicy-files", "window-thumbs");
}

function accountIdxOf(win) {
  // Windows tagged at creation expose cicyAccountIdx; otherwise the default
  // session (homepage / system windows) maps to 0.
  if (typeof win.cicyAccountIdx === "number") return win.cicyAccountIdx;
  try {
    const p = win.webContents.session.partition || "";
    const m = /^persist:sandbox-(\d+)$/.exec(p);
    if (m) return parseInt(m[1], 10);
  } catch (_) {}
  return 0;
}

async function captureOne(win, dir, { maxWidth, quality }) {
  if (win.isDestroyed()) return null;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return null;
  const image = await wc.capturePage();
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (!width || !height) return null;
  const scale = Math.min(1, maxWidth / width);
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const scaled = scale < 1 ? image.resize({ width: tw, height: th, quality: "good" }) : image;
  const buf = scaled.toJPEG(quality);
  const file = path.join(dir, `win-${win.id}.jpg`);
  fs.writeFileSync(file, buf);
  return {
    id: win.id,
    title: win.getTitle(),
    url: wc.getURL(),
    accountIdx: accountIdxOf(win),
    w: tw,
    h: th,
    file,
    bytes: buf.length,
    updatedAt: new Date().toISOString(),
  };
}

async function tick(opts) {
  if (running) return;
  running = true;
  try {
    const dir = thumbDir();
    fs.mkdirSync(dir, { recursive: true });
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const liveIds = new Set(wins.map((w) => w.id));

    // Prune thumbnails whose window is gone.
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = /^win-(\d+)\.jpg$/.exec(f);
        if (m && !liveIds.has(parseInt(m[1], 10))) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
        }
      }
    } catch (_) {}

    const manifest = [];
    for (const win of wins) {
      try {
        const entry = await captureOne(win, dir, opts);
        if (entry) manifest.push(entry);
      } catch (_) {
        // one window failing must never stop the rest
      }
    }
    try {
      fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(manifest, null, 2));
    } catch (_) {}
  } finally {
    running = false;
  }
}

function startWindowThumbnails(options = {}) {
  const opts = {
    intervalMs: options.intervalMs || 4000,
    maxWidth: options.maxWidth || 320, // small rect, chrome-ish
    quality: options.quality || 60,
  };
  stopWindowThumbnails();
  const kick = () => { tick(opts).catch(() => {}); };
  timer = setInterval(kick, opts.intervalMs);
  if (timer.unref) timer.unref();
  // First pass shortly after launch (let windows paint at least one frame).
  kickTimer = setTimeout(kick, 1500);
  if (kickTimer.unref) kickTimer.unref();
  return { dir: thumbDir(), ...opts };
}

function stopWindowThumbnails() {
  if (timer) { clearInterval(timer); timer = null; }
  if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
}

module.exports = { startWindowThumbnails, stopWindowThumbnails, thumbDir };
