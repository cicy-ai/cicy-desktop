// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const CDP = require("chrome-remote-interface");

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function getVersion(debuggerPort, host = "127.0.0.1") {
  return fetchJson(`http://${host}:${debuggerPort}/json/version`);
}

async function getTargets(debuggerPort, host = "127.0.0.1") {
  return fetchJson(`http://${host}:${debuggerPort}/json/list`);
}

async function createTarget(debuggerPort, targetUrl = "about:blank", host = "127.0.0.1") {
  const wantUrl = String(targetUrl || "about:blank");
  // Prefer the browser-level CDP endpoint (Target.createTarget over the browser
  // websocket). Newer Chrome (149+) rejects/closes the HTTP /json/new endpoint,
  // and — crucially — the browser websocket can open a tab even when there are
  // 0 page targets: the windowless Chrome that lingers on macOS after its last
  // window is closed. Without this, /json/new fails, ensurePageTargets can't
  // create a tab, and the profile is stuck at "No inspectable targets".
  try {
    const version = await getVersion(debuggerPort, host);
    const browserWs = version && version.webSocketDebuggerUrl;
    if (browserWs) {
      const res = await callCdp({
        debuggerPort,
        host,
        target: browserWs,
        method: "Target.createTarget",
        params: { url: wantUrl },
      });
      const id = res && res.targetId;
      if (id) return { id, targetId: id };
    }
  } catch (_) {
    // Fall through to the legacy HTTP endpoint (older Chrome / unexpected shape).
  }
  const url = `http://${host}:${debuggerPort}/json/new?${encodeURIComponent(wantUrl)}`;
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function activateTarget(debuggerPort, targetId, host = "127.0.0.1") {
  if (!targetId) {
    throw new Error("Missing targetId");
  }
  const url = `http://${host}:${debuggerPort}/json/activate/${encodeURIComponent(String(targetId))}`;
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${response.statusText} for ${url}`);
  }
  // Chrome returns text like "Target activated"; tolerate empty body.
  return response.text().catch(() => "");
}

async function waitForDebugger(debuggerPort, host = "127.0.0.1", timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const version = await getVersion(debuggerPort, host);
      if (version?.webSocketDebuggerUrl) {
        return version;
      }
      lastError = new Error(`Debugger on port ${debuggerPort} is missing webSocketDebuggerUrl`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Chrome debugger did not become ready on port ${debuggerPort}: ${lastError?.message || "timeout"}`
  );
}

function timeoutReject(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP ${label} timeout after ${ms}ms`)), ms));
}
// 给 CDP client 挂一个吞掉的 'error' 监听 —— chrome-remote-interface 的 client 是 EventEmitter,
// 底层 WS 掉线 / 目标页导航或关闭 / Chrome 崩溃时会 emit 'error'。**没有 'error' 监听时 Node 会
// 直接抛 → uncaughtException → 主进程(cicy-desktop)整个崩**。挂上它,错误仍会通过 send() 的
// reject 正常返回给调用方,只是不再炸进程。
function guardClient(client) {
  try { client.on("error", () => {}); } catch {}
  return client;
}

async function callCdp({ debuggerPort, method, params = {}, host = "127.0.0.1", target, timeoutMs = 30000 }) {
  const connectP = CDP(target ? { host, port: debuggerPort, target } : { host, port: debuggerPort });
  // 连接一旦成功就先挂 error 监听(哪怕后面因超时被丢弃,也不让这个"孤儿"连接之后的 WS error 崩进程),
  // 并在孤儿情况下关闭它。
  connectP.then((c) => guardClient(c)).catch(() => {});
  let client;
  try {
    client = await Promise.race([connectP, timeoutReject(timeoutMs, `connect ${host}:${debuggerPort}`)]);
  } catch (e) {
    connectP.then((c) => { try { c.close().catch(() => {}); } catch {} }).catch(() => {}); // 迟到的连接收尾
    throw e;
  }
  guardClient(client);
  try {
    return await Promise.race([client.send(method, params || {}), timeoutReject(timeoutMs, method)]);
  } finally {
    try { await client.close().catch(() => {}); } catch {}
  }
}

module.exports = {
  getVersion,
  getTargets,
  createTarget,
  activateTarget,
  waitForDebugger,
  callCdp,
};
