// Shared GitHub mirror registry for CN-network downloads.
//
// Mirror strategies:
//   "prepend" — mirror acts as a reverse proxy prefix:
//               https://<mirror>/<original-github-url>
//   "domain"  — replace "github.com" with the mirror domain:
//               https://<mirror>/owner/repo/releases/download/...
//
// All current mirrors are prepend-style. Add domain-style entries as needed.

const MIRRORS = [
  { url: "https://gh.llkk.cc/",      type: "prepend" },
  { url: "https://ghproxy.net/",     type: "prepend" },
  { url: "https://gh-proxy.com/",    type: "prepend" },
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

  for (const m of MIRRORS) {
    const base = mirrorUrl(feedBase, m);
    if (await probe(base + "/latest.yml")) return base;
  }
  return feedBase; // fallback: direct
}

module.exports = { MIRRORS, mirrorUrl, buildUrlList, resolveFeedUrl };
