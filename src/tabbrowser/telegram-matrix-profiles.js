const DEFAULT_PROXY = "http://127.0.0.1:20001";

function nextProfileId(profiles) {
  const ids = (profiles || []).map((p) => Number(p.accountIdx)).filter((id) => Number.isInteger(id) && id > 0);
  let id = (ids.length ? Math.max(...ids) : 0) + 1;
  if (id === 9) id = 10;
  return id;
}

function normalizeTelegramProxy(value) {
  const proxy = String(value || "").trim();
  if (!proxy) return "";
  let parsed;
  try { parsed = new URL(proxy); } catch (e) { throw new Error("Proxy must be a valid http, https, socks5 URL"); }
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol)) {
    throw new Error("Proxy protocol must be http, https, socks5, or empty for direct mode");
  }
  if (!parsed.hostname) throw new Error("Proxy must include a host");
  return proxy;
}

function profileStore(store) { return store || require("../profiles/profile-store"); }

function addTelegramProfile(store, defaultProxy = DEFAULT_PROXY) {
  const target = profileStore(store);
  const id = nextProfileId(target.listProfiles("electron"));
  return target.setProxy("electron", id, normalizeTelegramProxy(defaultProxy));
}

function setTelegramProfileProxy(accountIdx, proxy, store) {
  const id = Number(accountIdx);
  if (!Number.isInteger(id) || id <= 0 || id === 9) throw new Error("Invalid Electron profile ID");
  return profileStore(store).setProxy("electron", id, normalizeTelegramProxy(proxy));
}

module.exports = {
  DEFAULT_PROXY,
  nextProfileId,
  normalizeTelegramProxy,
  addTelegramProfile,
  setTelegramProfileProxy,
};
