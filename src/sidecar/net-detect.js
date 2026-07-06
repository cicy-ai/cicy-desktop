// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Detect whether the host is on the China mainland network.
// Strategy:
//   - Probe both google.com (typically blocked in CN) and baidu.com (typically reachable in CN).
//   - Race with short timeout. Result cached for the process lifetime.
// Result categories:
//   "cn"      — google blocked, baidu reachable
//   "global"  — google reachable
//   "unknown" — neither reachable (offline?), default to global with mirror fallback
//
// Callers should treat "cn" and "unknown" as "prefer mirror first, fall back to direct".

const https = require("https");
const log = require("electron-log");

let cached = null;
const TIMEOUT_MS = 2500;

function probe(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: TIMEOUT_MS, method: "HEAD" }, (res) => {
      res.resume();
      resolve(res.statusCode > 0 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function detect({ force = false } = {}) {
  if (!force && cached) return cached;
  try {
    const [google, baidu] = await Promise.all([
      probe("https://www.google.com/generate_204"),
      probe("https://www.baidu.com/"),
    ]);
    let result;
    if (google) result = "global";
    else if (baidu) result = "cn";
    else result = "unknown";
    log.info(`[net-detect] google=${google} baidu=${baidu} → ${result}`);
    cached = result;
    return result;
  } catch (e) {
    log.warn(`[net-detect] probe failed: ${e.message}`);
    cached = "unknown";
    return "unknown";
  }
}

module.exports = { detect };
