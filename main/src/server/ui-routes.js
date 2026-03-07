const express = require("express");
const { BrowserWindow } = require("electron");
const router = express.Router();

function uiAuth(req, res, next) {
  const manager = global.authManager;
  const queryToken = req.query.token;
  if (queryToken && queryToken === manager.getToken()) return next();
  if (manager.validateAuth(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// GET /ui/windows → JSON list of all BrowserWindows
router.get("/windows", uiAuth, (req, res) => {
  const wins = BrowserWindow.getAllWindows().map((w) => ({
    win_id: w.id,
    title: w.getTitle(),
    url: w.webContents.getURL(),
    bounds: w.getBounds(),
    isVisible: w.isVisible(),
    isDestroyed: w.isDestroyed(),
  }));
  res.json({ windows: wins });
});

// GET /ui/snapshot?win_id=X[&quality=80] → JPEG image, scaled to 50% of window size
router.get("/snapshot", uiAuth, async (req, res) => {
  const winId = parseInt(req.query.win_id);
  if (isNaN(winId)) return res.status(400).json({ error: "win_id required" });
  const win = BrowserWindow.fromId(winId);
  if (!win) return res.status(404).json({ error: "Window not found" });
  const quality = Math.min(100, Math.max(1, parseInt(req.query.quality) || 80));
  const scale = Math.min(1, Math.max(0.1, parseFloat(req.query.scale) || 0.5));
  try {
    const image = await win.webContents.capturePage();
    const { width, height } = image.getSize();
    const scaled = image.resize({
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
    });
    const buf = scaled.toJPEG(quality);
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ui/close-window { win_id }
router.post("/close-window", uiAuth, (req, res) => {
  const winId = parseInt(req.body.win_id);
  if (isNaN(winId)) return res.status(400).json({ error: "win_id required" });
  const win = BrowserWindow.fromId(winId);
  if (!win) return res.status(404).json({ error: "Window not found" });
  win.destroy();
  res.json({ ok: true });
});

// POST /ui/close-all
router.post("/close-all", uiAuth, (req, res) => {
  BrowserWindow.getAllWindows().forEach((w) => w.destroy());
  res.json({ ok: true });
});

// POST /ui/set-bounds { win_id, x, y, width, height }
router.post("/set-bounds", uiAuth, (req, res) => {
  const winId = parseInt(req.body.win_id);
  if (isNaN(winId)) return res.status(400).json({ error: "win_id required" });
  const win = BrowserWindow.fromId(winId);
  if (!win) return res.status(404).json({ error: "Window not found" });
  const bounds = {};
  if (req.body.x !== undefined) bounds.x = parseInt(req.body.x);
  if (req.body.y !== undefined) bounds.y = parseInt(req.body.y);
  if (req.body.width !== undefined) bounds.width = parseInt(req.body.width);
  if (req.body.height !== undefined) bounds.height = parseInt(req.body.height);
  win.setBounds(bounds);
  res.json({ ok: true, bounds: win.getBounds() });
});

module.exports = router;
