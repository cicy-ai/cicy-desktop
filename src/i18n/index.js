// CiCy Desktop i18n.
// Single instance shared between main process and preload (loaded via require).
// - locale comes from app.getLocale() (set in main.js init)
// - resources are loaded eagerly from src/i18n/locales/*.json
// - usage: const { t } = require("./i18n"); t("tray.openHomepage")

const fs = require("fs");
const path = require("path");
const i18next = require("i18next");

const SUPPORTED = ["en", "zh-CN", "ja", "fr"];
const FALLBACK = "en";

let initialized = false;

function loadLocale(code) {
  const file = path.join(__dirname, "locales", `${code}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function pickLocale(rawLocale) {
  if (!rawLocale) return FALLBACK;
  const lower = rawLocale.toLowerCase();
  // exact match
  for (const code of SUPPORTED) if (code.toLowerCase() === lower) return code;
  // language prefix match (zh-CN, zh-Hans → zh-CN)
  const prefix = lower.split(/[-_]/)[0];
  for (const code of SUPPORTED) if (code.toLowerCase().split(/[-_]/)[0] === prefix) return code;
  return FALLBACK;
}

function init(rawLocale) {
  if (initialized) return i18next;
  const lng = pickLocale(rawLocale);
  const resources = {};
  for (const code of SUPPORTED) resources[code] = { translation: loadLocale(code) };
  i18next.init({
    lng,
    fallbackLng: FALLBACK,
    resources,
    interpolation: { escapeValue: false },
  });
  initialized = true;
  return i18next;
}

function t(key, opts) {
  if (!initialized) init(); // lazy default
  return i18next.t(key, opts);
}

module.exports = { init, t, i18next, SUPPORTED, FALLBACK, pickLocale };
