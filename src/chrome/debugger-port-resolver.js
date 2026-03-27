const fs = require("fs");
const os = require("os");
const path = require("path");

const { getChromeRuntimeRegistry } = require("./runtime-registry");

const PRIVATE_CHROME_JSON = path.join(os.homedir(), "Private", "chrome.json");

function readPrivateChromeConfig() {
  if (!fs.existsSync(PRIVATE_CHROME_JSON)) return {};
  return JSON.parse(fs.readFileSync(PRIVATE_CHROME_JSON, "utf-8"));
}

function getConfiguredDebuggerPort(accountIdx, chromeConfig = readPrivateChromeConfig()) {
  const entry = chromeConfig?.[`account_${accountIdx}`];
  return typeof entry?.port === "number" ? entry.port : null;
}

function resolveChromeDebuggerPort(
  accountIdx,
  { registry = getChromeRuntimeRegistry(), chromeConfig } = {}
) {
  const configuredPort = getConfiguredDebuggerPort(
    accountIdx,
    chromeConfig ? chromeConfig : readPrivateChromeConfig()
  );
  if (typeof configuredPort === "number") {
    return { debuggerPort: configuredPort, source: "private-config" };
  }

  const runtimePort = registry.get(accountIdx)?.debuggerPort;
  if (typeof runtimePort === "number") {
    return { debuggerPort: runtimePort, source: "runtime-registry" };
  }

  return { debuggerPort: null, source: null };
}

module.exports = {
  PRIVATE_CHROME_JSON,
  readPrivateChromeConfig,
  getConfiguredDebuggerPort,
  resolveChromeDebuggerPort,
};
