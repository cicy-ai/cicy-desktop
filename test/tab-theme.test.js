// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const test = require("node:test");

let resolveReportedCicyTheme;
let resolveTabChromeTheme;
try {
  ({ resolveReportedCicyTheme, resolveTabChromeTheme } = require("../src/tabbrowser/tab-theme"));
} catch (_) {}

test("the active cicy-code team tab controls the desktop tab chrome theme", () => {
  assert.equal(typeof resolveTabChromeTheme, "function");
  assert.equal(
    resolveTabChromeTheme([
      { id: 1, active: false, team: true, cicyTheme: "dark" },
      { id: 2, active: true, team: true, cicyTheme: "light" },
    ]),
    "light"
  );
  assert.equal(
    resolveTabChromeTheme([{ id: 2, active: true, team: true, cicyTheme: "dark" }]),
    "dark"
  );
});

test("inactive cicy-code tabs and ordinary pages cannot recolor the desktop chrome", () => {
  assert.equal(
    resolveTabChromeTheme([
      { id: 1, active: false, team: true, cicyTheme: "light" },
      { id: 2, active: true, team: false, cicyTheme: "light" },
    ]),
    "dark"
  );
  assert.equal(resolveTabChromeTheme([]), "dark");
});

test("cicy-code reports its document theme, then its saved preference, then light by default", () => {
  assert.equal(typeof resolveReportedCicyTheme, "function");
  assert.equal(resolveReportedCicyTheme("light", "dark"), "light");
  assert.equal(resolveReportedCicyTheme("", "dark"), "dark");
  assert.equal(resolveReportedCicyTheme("system", "sepia"), "light");
});
