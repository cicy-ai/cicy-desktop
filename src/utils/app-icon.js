// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Resolve the bundled app icon for BrowserWindow({ icon }).
//
// When cicy-desktop runs UNPACKAGED (npx / npm i -g — the mac/win/linux default,
//), there is no electron-builder .exe to embed the icon, so every window
// falls back to the stock Electron icon unless we point BrowserWindow at our own
// icon file explicitly. The icons ship in build/ (published — no files[]/​.npmignore
// excludes it). Windows wants a .ico; linux a .png; macOS takes the dock icon
// from elsewhere but a .png here is harmless.
const path = require("path");

const ROOT = path.join(__dirname, "..", ".."); // src/utils → package root
const ICON = {
  win32: path.join(ROOT, "build", "icon.ico"),
  linux: path.join(ROOT, "build", "icon.png"),
  darwin: path.join(ROOT, "build", "icon.png"),
};

function appIconPath() {
  return ICON[process.platform] || ICON.linux;
}

module.exports = { appIconPath };
