const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CHROME_INSTALL_URL,
  handleChromeLaunchError,
  isChromeBinaryMissingError,
} = require("../src/chrome/chrome-install-navigation");

test("recognizes the missing Chrome binary error", () => {
  assert.equal(isChromeBinaryMissingError(new Error(
    "Chrome/Chromium binary not found. Please configure chromeBinary or --chrome-binary."
  )), true);
  assert.equal(isChromeBinaryMissingError(new Error("Chrome failed to start")), false);
});

test("opens the Chrome installation page instead of showing an error", async () => {
  const events = [];
  const handled = await handleChromeLaunchError(
    new Error("Chrome/Chromium binary not found."),
    {
      openInstallPage: (url) => events.push(["open", url]),
      showError: () => events.push(["error"]),
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(events, [["open", CHROME_INSTALL_URL]]);
});

test("keeps the normal error UI for unrelated Chrome failures", async () => {
  const events = [];
  const error = new Error("debugging port unavailable");
  const handled = await handleChromeLaunchError(error, {
    openInstallPage: () => events.push(["open"]),
    showError: (received) => events.push(["error", received]),
  });

  assert.equal(handled, false);
  assert.deepEqual(events, [["error", error]]);
});
