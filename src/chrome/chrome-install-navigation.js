// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const CHROME_INSTALL_URL = "https://www.google.com/chrome/";

function isChromeBinaryMissingError(error) {
  return /Chrome\/Chromium binary not found/i.test(String((error && error.message) || error || ""));
}

async function handleChromeLaunchError(error, { openInstallPage, showError }) {
  if (isChromeBinaryMissingError(error)) {
    await openInstallPage(CHROME_INSTALL_URL);
    return true;
  }
  await showError(error);
  return false;
}

module.exports = {
  CHROME_INSTALL_URL,
  handleChromeLaunchError,
  isChromeBinaryMissingError,
};
