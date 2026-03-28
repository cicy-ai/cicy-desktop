const fs = require("fs");
const os = require("os");
const path = require("path");

const { getDefaultDebuggerPort } = require("../chrome/chrome-launcher");
const { config } = require("../config");

const PRIVATE_CHROME_JSON = path.join(os.homedir(), "Private", "chrome.json");

class ChromeProfileResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChromeProfileResolutionError";
    this.statusCode = 400;
  }
}

function toTildePath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.length === 0) return inputPath;
  if (inputPath === "~" || inputPath.startsWith("~/")) return inputPath;

  const home = os.homedir();
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (!inputPath.startsWith(homeWithSep)) return inputPath;

  const rel = inputPath.slice(homeWithSep.length);
  // Force forward slashes so workers on Windows can still parse "~/...".
  return `~/${rel.split(path.sep).join("/")}`;
}

function readMasterChromeConfig() {
  if (!fs.existsSync(PRIVATE_CHROME_JSON)) {
    throw new ChromeProfileResolutionError(`Missing master chrome.json: ${PRIVATE_CHROME_JSON}`);
  }

  try {
    return JSON.parse(fs.readFileSync(PRIVATE_CHROME_JSON, "utf-8"));
  } catch (error) {
    throw new ChromeProfileResolutionError(
      `Failed to parse master chrome.json (${PRIVATE_CHROME_JSON}): ${error.message}`
    );
  }
}

function getMasterChromeAccountEntry(accountIdx) {
  if (typeof accountIdx !== "number" || !Number.isFinite(accountIdx)) {
    throw new ChromeProfileResolutionError(`Invalid accountIdx: ${accountIdx}`);
  }

  const data = readMasterChromeConfig();
  const key = `account_${accountIdx}`;
  const entry = data?.[key] || null;
  if (!entry) {
    throw new ChromeProfileResolutionError(`Missing chrome.json entry on master: ${key}`);
  }

  return { profileKey: key, accountIdx, entry };
}

function normalizeEffectiveChromeProfile({ accountIdx, entry }) {
  const safeEntry = entry && typeof entry === "object" ? entry : {};

  const gmail = typeof safeEntry.gmail === "string" ? safeEntry.gmail : "";
  const platform = safeEntry.platform && typeof safeEntry.platform === "object" ? safeEntry.platform : {};

  const rpaDirRaw =
    typeof safeEntry.rpaDir === "string" && safeEntry.rpaDir.length
      ? safeEntry.rpaDir
      : `~/chrome/account_${accountIdx}`;

  const orgPathRaw = typeof safeEntry.orgPath === "string" && safeEntry.orgPath.length ? safeEntry.orgPath : null;

  const port =
    typeof safeEntry.port === "number"
      ? safeEntry.port
      : getDefaultDebuggerPort(accountIdx, config.chromeDebuggerBasePort);

  return {
    accountIdx,
    gmail,
    rpaDir: toTildePath(rpaDirRaw),
    orgPath: orgPathRaw ? toTildePath(orgPathRaw) : null,
    port,
    proxy: safeEntry.proxy,
    platform,
  };
}

function resolveEffectiveChromeProfileByAccountIdx(accountIdx) {
  const cfg = getMasterChromeAccountEntry(accountIdx);
  return normalizeEffectiveChromeProfile(cfg);
}

module.exports = {
  ChromeProfileResolutionError,
  resolveEffectiveChromeProfileByAccountIdx,
};
