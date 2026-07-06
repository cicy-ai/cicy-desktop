// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Queries GitHub for the latest cicy-code release and compares against the
// version currently reported by the bundled sidecar (via /api/health).
// Phase 1 surface: { hasUpdate, currentVersion, latestVersion, releaseUrl }.
// Actual download + binary replace + sidecar restart is intentionally NOT
// wired here — the homepage's "Download & Install" button opens releaseUrl
// in the system browser for now (matches the unsigned-app trade-off).

const https = require("https");
const { shell } = require("electron");

const REPO = "cicy-ai/cicy-code";

function semverGreater(a, b) {
  // Strip leading "v" and any pre-release suffix; compare numeric tuples.
  const parse = s => String(s || "").replace(/^v/, "").split("-")[0].split(".").map(n => parseInt(n, 10) || 0);
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function fetchLatest({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "GET",
      hostname: "api.github.com",
      path: `/repos/${REPO}/releases/latest`,
      headers: {
        "User-Agent": "cicy-desktop-updater",
        "Accept": "application/vnd.github+json",
      },
      timeout: timeoutMs,
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`GitHub releases returned ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function checkForUpdate({ currentVersion } = {}) {
  const release = await fetchLatest();
  const latestVersion = String(release.tag_name || "").replace(/^v/, "");
  return {
    hasUpdate: !!currentVersion && semverGreater(latestVersion, currentVersion),
    currentVersion: currentVersion || null,
    latestVersion,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    notes: (release.body || "").slice(0, 600),
  };
}

function openReleaseInBrowser(url) {
  if (!url) return false;
  shell.openExternal(url);
  return true;
}

module.exports = { checkForUpdate, openReleaseInBrowser, semverGreater };
