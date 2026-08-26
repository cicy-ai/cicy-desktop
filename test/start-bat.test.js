const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("kills installed CiCy Desktop processes before starting source Electron", () => {
  const bat = fs.readFileSync(path.join(__dirname, "..", "..", "start-cicy-desktop-win.bat"), "utf8");
  const killDesktop = bat.indexOf('taskkill /F /T /IM "cicy-desktop.exe"');
  const killProduct = bat.indexOf('taskkill /F /T /IM "CiCy Desktop.exe"');
  const killSourceElectron = bat.indexOf("C:\\projects\\cicy-desktop-win");
  const electronFilter = bat.indexOf("Win32_Process");
  const start = bat.indexOf("call npm start");

  assert.ok(killDesktop >= 0, "must kill cicy-desktop.exe");
  assert.ok(killProduct >= 0, "must kill CiCy Desktop.exe");
  assert.ok(electronFilter >= 0 && killSourceElectron >= 0, "must target source electron by command line");
  assert.ok(killDesktop < start && killProduct < start && electronFilter < start, "kills must happen before npm start");
});
