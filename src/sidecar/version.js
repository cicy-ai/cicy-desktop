// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// cicy-code 版本的唯一读法。三个概念一个模块,别处不准再自己解析 /api/health、
// 也不准再直连 npm 拿版本("拿版本就一个方法")。
//   running(port) → 活着的 daemon 在 /api/health 报的版本(“正在跑什么”的唯一真相)
//   latest()      → npm 上最新版(和 update() 升级到的同一个号)
//   installed()   → 磁盘 binary 版本(localbin manifest,诊断用)
const http = require("http");

const DEFAULT_PORT = 8008;

// The ONE running-version reader. GET /api/health → version. Returns the version
// string, or null on any failure / missing field. Used by the update flow's
// post-restart verification AND surfaced to the UI via the sidecar:versions IPC.
//
// timeout=4000 (not 1500): on Windows Node's http.get to 127.0.0.1:8008 routinely
// takes 1.5–5s (localhost goes through 360/Defender socket inspection) even though
// curl is instant — a 1500ms cap returned null while the daemon was fine. Connection:
// close makes the Go server end the response promptly instead of holding keep-alive.
function running(port = DEFAULT_PORT, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs, headers: { Connection: "close" } }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; if (body.length > 8192) body = body.slice(0, 8192); });
      res.on("end", () => { resolve(parseHealthVersion(body)); });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// The ONE way to pull the version out of a /api/health body — shared so every
// caller (this module + local-teams' liveness probe) parses identically.
function parseHealthVersion(body) {
  try { const j = JSON.parse(body); return String(j?.version || j?.data?.version || "").trim() || null; }
  catch { return null; }
}

async function latest() {
  try { return await require("./localbin").latestVersion(); } catch { return null; }
}

function installed() {
  try { return require("./localbin").currentVersion(); } catch { return null; }
}

module.exports = { running, latest, installed, parseHealthVersion, DEFAULT_PORT };
