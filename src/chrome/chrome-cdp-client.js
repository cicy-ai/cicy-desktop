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

async function callCdp({ debuggerPort, method, params = {}, host = "127.0.0.1", target }) {
  const client = await CDP(target ? { host, port: debuggerPort, target } : { host, port: debuggerPort });
  try {
    return await client.send(method, params || {});
  } finally {
    await client.close().catch(() => {});
  }
}

module.exports = {
  getVersion,
  getTargets,
  activateTarget,
  waitForDebugger,
  callCdp,
};
