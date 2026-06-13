// Per-profile egress IP + geo probe. Fetches an IP-info API THROUGH a given
// Electron session (so the result reflects that profile's proxy egress), in the
// main process via net.request (no browser launch needed). Returns
// { ip, area } — area is "country · region · city" (blank parts dropped).
//
// NOTE: the opposite of cloud-client's detectIpGeo (which deliberately goes
// DIRECT for the *machine's* egress). Here we WANT the proxy path, per profile.
const { net } = require("electron");

function fetchJsonViaSession(url, ses, timeoutMs = 7000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = net.request({ url, session: ses, useSessionCookies: false });
      const to = setTimeout(() => { try { req.abort(); } catch (_) {} finish(null); }, timeoutMs);
      let body = "";
      req.on("response", (res) => {
        res.on("data", (d) => { body += d; });
        res.on("end", () => { clearTimeout(to); try { finish(JSON.parse(body)); } catch (_) { finish(null); } });
        res.on("error", () => { clearTimeout(to); finish(null); });
      });
      req.on("error", () => { clearTimeout(to); finish(null); });
      req.end();
    } catch (_) { finish(null); }
  });
}

const joinArea = (...parts) => parts.filter((p) => typeof p === "string" && p.trim()).join(" · ");

// Probe egress IP + geo via the given session. Primary: api.myip.com
// ({ ip, country, cc }) — same endpoint as `agent-chrome ip`. Falls back to
// ip-api.com (adds region/city) then ipify (ip only). Never throws.
async function probeIpViaSession(ses) {
  let j = await fetchJsonViaSession("https://api.myip.com", ses);
  if (j && typeof j.ip === "string" && j.ip) {
    return { ip: j.ip, area: joinArea(j.cc, j.country) };
  }
  j = await fetchJsonViaSession("http://ip-api.com/json", ses);
  if (j && typeof j.query === "string" && j.query) {
    return { ip: j.query, area: joinArea(j.country, j.regionName, j.city) };
  }
  j = await fetchJsonViaSession("https://api.ipify.org?format=json", ses);
  if (j && typeof j.ip === "string" && j.ip) {
    return { ip: j.ip, area: "" };
  }
  return { ip: "", area: "" };
}

module.exports = { probeIpViaSession, fetchJsonViaSession };
