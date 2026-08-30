// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Shared GitHub mirror registry for CN-network downloads.
//
// Mirror strategies:
//   "prepend" — mirror acts as a reverse proxy prefix:
//               https://<mirror>/<original-github-url>
//   "domain"  — replace "github.com" with the mirror domain:
//               https://<mirror>/owner/repo/releases/download/...
//
// All current mirrors are prepend-style. Add domain-style entries as needed.

// 自更新 CN feed 首选自建 R2(Cloudflare)。原先的 Aliyun OSS 已下线(账号停用,
// 整桶 403 UserDisable),不再作为来源。gh-proxy.com 反代已删(不稳/有问题);
// ghproxy.net 留作 R2 不可达时的兜底镜像。非 CN 走 GitHub 直连(见 app-updater)。
// 注意:R2 从中国大陆的下载速度明显不如原来的 OSS,大文件(rootfs/镜像)会更慢。
const R2_RELEASES_BASE = process.env.CICY_R2_RELEASES_BASE
  || process.env.CICY_OSS_RELEASES_BASE  // 兼容旧变量名
  || "https://r2.deepfetch.de5.net/releases";

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

  // CN 首选 R2:R2 上有 electron-updater feed(latest*.yml)才用它。
  if (await probe(R2_RELEASES_BASE + "/latest.yml")) return R2_RELEASES_BASE;
  for (const m of MIRRORS) {
    const base = mirrorUrl(feedBase, m);
    if (await probe(base + "/latest.yml")) return base;
  }
  return feedBase; // fallback: direct
}

module.exports = { MIRRORS, R2_RELEASES_BASE, mirrorUrl, buildUrlList, resolveFeedUrl };
