// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

async function restoredCicyCodeUrl(readContainerToken) {
  const token = String(await readContainerToken() || "").trim();
  if (!token) return "";
  return `http://127.0.0.1:8008/?token=${encodeURIComponent(token)}`;
}

module.exports = { restoredCicyCodeUrl };
