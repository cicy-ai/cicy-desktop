const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BAT = path.join(__dirname, "..", "..", "start-cicy-desktop-win.bat");

// The bat lives on the Windows host next to the repo (C:\projects), not in git.
test("kills installed CiCy Desktop processes before starting source Electron", { skip: !fs.existsSync(BAT) && "host-only start bat not present" }, () => {
  const bat = fs.readFileSync(BAT, "utf8");
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
