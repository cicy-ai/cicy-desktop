// Launcher window — the native HTML list/add UI for backends. Singleton:
// re-clicking the menu item brings the existing one to the front.

const path = require("path");
const { BrowserWindow } = require("electron");

let launcher = null;

function openLauncher() {
  if (launcher && !launcher.isDestroyed()) {
    if (launcher.isMinimized()) launcher.restore();
    launcher.focus();
    return launcher;
  }
  launcher = new BrowserWindow({
    width: 620,
    height: 560,
    title: "CiCy Desktop — Backends",
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "launcher-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  launcher.loadFile(path.join(__dirname, "launcher.html"));
  launcher.on("closed", () => { launcher = null; });
  return launcher;
}

module.exports = { openLauncher };
