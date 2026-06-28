// Shared GitHub mirror registry for CN-network downloads.
//
// Mirror strategies:
//   "prepend" — mirror acts as a reverse proxy prefix:
//               https://<mirror>/<original-github-url>
//   "domain"  — replace "github.com" with the mirror domain:
//               https://<mirror>/owner/repo/releases/download/...
//
// All current mirrors are prepend-style. Add domain-style entries as needed.

// 自更新 CN feed 首选 OSS(自建,稳)。gh-proxy.com 反代已删(不稳/有问题);
// ghproxy.net 留作 OSS 不可达时的兜底镜像。非 CN 走 GitHub 直连(见 app-updater)。
const OSS_RELEASES_BASE = process.env.CICY_OSS_RELEASES_BASE
  || "https://cicy-1372193042-cn.oss-cn-shanghai.aliyuncs.com/releases";

const MIRRORS = [
  // gh.llkk.cc / gh-proxy.com removed — unreachable / unstable from APAC.
  // Re-add only after re-validating reachability.
  { url: "https://ghproxy.net/",     type: "prepend" },
  // { url: "hub.gitmirror.com",     type: "domain"  },  // example domain-replace
];

/**
 * Build a mirrored URL for a GitHub asset.
 * @param {string} githubUrl  e.g. https://github.com/owner/repo/releases/download/v1/file
 * @param {{ url: string, type: string }} mirror
 */
function mirrorUrl(githubUrl, mirror) {
  if (mirror.type === "domain") {
    return githubUrl.replace("https://github.com", `https://${mirror.url}`);
  }
  // prepend (default)
  return mirror.url + githubUrl;
}

/**
 * Return an ordered URL list for a GitHub asset.
 * CN:     mirrors first (parallel race the lot, pick fastest)
 * global: direct first, mirrors as fallback
 */
function buildUrlList(githubUrl, network) {
  const mirrored = MIRRORS.map(m => mirrorUrl(githubUrl, m));
  return network === "cn"
    ? [...mirrored, githubUrl]
    : [githubUrl, ...mirrored];
}

/**
 * For electron-updater generic provider: return the feed base URL that
 * points at the first reachable mirror (or direct if all mirrors fail).
 * feedBase is the directory URL ending without trailing slash, e.g.:
 *   https://github.com/cicy-ai/cicy-desktop/releases/latest/download
 */
async function resolveFeedUrl(feedBase) {
  const https = require("https");
  const probe = (url) => new Promise(resolve => {
    const req = https.request(url, { method: "HEAD", timeout: 4000 }, r => resolve(r.statusCode < 400));
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });

  // CN 首选 OSS:OSS 上有 electron-updater feed(latest*.yml)才用它。
  if (await probe(OSS_RELEASES_BASE + "/latest.yml")) return OSS_RELEASES_BASE;
  for (const m of MIRRORS) {
    const base = mirrorUrl(feedBase, m);
    if (await probe(base + "/latest.yml")) return base;
  }
  return feedBase; // fallback: direct
}

module.exports = { MIRRORS, OSS_RELEASES_BASE, mirrorUrl, buildUrlList, resolveFeedUrl };
