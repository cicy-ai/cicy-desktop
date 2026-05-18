// Tracks BrowserWindows opened via openWindowForBackend, mapping each window
// back to the backend that spawned it. Used by the homepage's "Recent
// Windows" section. Cleans up on close.

const { BrowserWindow } = require("electron");

// id (BrowserWindow.id) -> { backendId, openedAt, title }
const tracked = new Map();

function register(win, backendId) {
  if (!win || typeof win.id !== "number") return;
  const entry = { backendId, openedAt: Date.now(), title: "" };
  tracked.set(win.id, entry);
  // Title may not be set until after page-title-updated.
  win.on("page-title-updated", (_e, title) => {
    entry.title = title || entry.title;
  });
  win.on("closed", () => { tracked.delete(win.id); });
  if (win.webContents && win.webContents.getTitle) {
    entry.title = win.webContents.getTitle();
  }
}

function list() {
  const out = [];
  for (const [id, entry] of tracked.entries()) {
    const win = BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) { tracked.delete(id); continue; }
    out.push({
      windowId: id,
      backendId: entry.backendId,
      openedAt: entry.openedAt,
      title: entry.title || win.getTitle() || "",
      isFocused: win.isFocused(),
      isVisible: win.isVisible(),
    });
  }
  return out.sort((a, b) => b.openedAt - a.openedAt);
}

function focus(windowId) {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

module.exports = { register, list, focus };
