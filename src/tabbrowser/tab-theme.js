// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

function normalizeCicyTheme(theme) {
  return theme === "light" || theme === "dark" ? theme : null;
}

function resolveReportedCicyTheme(documentTheme, savedTheme) {
  return normalizeCicyTheme(documentTheme) || normalizeCicyTheme(savedTheme) || "light";
}

function resolveTabChromeTheme(tabs) {
  const active = Array.isArray(tabs) ? tabs.find((tab) => tab && tab.active) : null;
  if (!active || !active.team) return "dark";
  return normalizeCicyTheme(active.cicyTheme) || "dark";
}

module.exports = { normalizeCicyTheme, resolveReportedCicyTheme, resolveTabChromeTheme };
