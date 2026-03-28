const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_REACHABILITY_TIMEOUT_MS = 1500;
const DEFAULT_REACHABILITY_TTL_MS = 5000;

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function getDefaultPort(protocol) {
  if (protocol === "http:") return "80";
  if (protocol === "https:") return "443";
  return "";
}

function normalizeWorkerBaseUrl(baseUrl) {
  if (!baseUrl) return null;

  try {
    const url = new URL(baseUrl);
    const protocol = url.protocol.toLowerCase();
    const hostname = isLoopbackHostname(url.hostname.toLowerCase())
      ? "127.0.0.1"
      : url.hostname.toLowerCase();
    const port = url.port || getDefaultPort(protocol);
    const pathname = (url.pathname || "").replace(/\/+$/, "");
    const normalizedPath = pathname === "/" ? "" : pathname;
    return `${protocol}//${hostname}${port ? `:${port}` : ""}${normalizedPath}`;
  } catch {
    return String(baseUrl).trim().replace(/\/+$/, "").toLowerCase() || null;
  }
}

function readJson(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function getNodeConfigPath() {
  return path.join(os.homedir(), "Private", "cicy-desktop.json");
}

function readGlobalConfig(configPath = path.join(os.homedir(), "global.json")) {
  return readJson(configPath);
}

function readNodeConfig(configPath = getNodeConfigPath()) {
  return readJson(configPath);
}

function loadConfiguredNodes(configPath) {
  const config = readNodeConfig(configPath);
  const globalConfig = readGlobalConfig();
  const nodes = config.cicyDesktopNodes || {};
  const fallbackToken = globalConfig.api_token || "";

  return Object.entries(nodes)
    .map(([configNodeName, node]) => {
      const baseUrl = typeof node?.base_url === "string" ? node.base_url.trim() : "";
      if (!baseUrl) return null;

      const authToken = node.api_token || fallbackToken || "";
      return {
        workerId: `configured:${configNodeName}`,
        configNodeName,
        configured: true,
        registered: false,
        source: "configured",
        baseUrl,
        normalizedBaseUrl: normalizeWorkerBaseUrl(baseUrl),
        hasAuthToken: Boolean(authToken),
        agents: [],
        capabilities: [],
        resources: null,
        lastHeartbeatAt: null,
        registeredAt: null,
        healthStatus: "offline",
        registrationStatus: "unregistered",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.configNodeName.localeCompare(b.configNodeName));
}

function sanitizeInventoryWorker(worker) {
  if (!worker) return null;

  const { authToken, ...safeWorker } = worker;
  return safeWorker;
}

async function probeReachability(
  baseUrl,
  { timeoutMs = DEFAULT_REACHABILITY_TIMEOUT_MS, fetchImpl = fetch } = {}
) {
  if (!baseUrl) {
    return {
      reachable: false,
      reachabilityStatus: "unknown",
      reachabilityCheckedAt: new Date().toISOString(),
      reachabilityError: null,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/observability/healthz`, {
      method: "GET",
      signal: controller.signal,
    });

    return {
      reachable: response.ok,
      reachabilityStatus: response.ok ? "reachable" : "unreachable",
      reachabilityCheckedAt: new Date().toISOString(),
      reachabilityError: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      reachabilityStatus: "unreachable",
      reachabilityCheckedAt: new Date().toISOString(),
      reachabilityError: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

class WorkerInventory {
  constructor({
    workerRegistry,
    configPath = getNodeConfigPath(),
    probeTimeoutMs = DEFAULT_REACHABILITY_TIMEOUT_MS,
    probeTtlMs = DEFAULT_REACHABILITY_TTL_MS,
    loadConfiguredNodesImpl = loadConfiguredNodes,
    probeReachabilityImpl = probeReachability,
  }) {
    this.workerRegistry = workerRegistry;
    this.configPath = configPath;
    this.probeTimeoutMs = probeTimeoutMs;
    this.probeTtlMs = probeTtlMs;
    this.loadConfiguredNodesImpl = loadConfiguredNodesImpl;
    this.probeReachabilityImpl = probeReachabilityImpl;
    this.reachabilityCache = new Map();
  }

  getConfiguredNodes() {
    return this.loadConfiguredNodesImpl(this.configPath);
  }

  async getReachability(worker) {
    const normalizedBaseUrl = normalizeWorkerBaseUrl(worker?.baseUrl);
    if (!normalizedBaseUrl) {
      return {
        reachable: false,
        reachabilityStatus: "unknown",
        reachabilityCheckedAt: new Date().toISOString(),
        reachabilityError: null,
      };
    }

    const cached = this.reachabilityCache.get(normalizedBaseUrl);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await this.probeReachabilityImpl(worker.baseUrl, {
      timeoutMs: this.probeTimeoutMs,
    });
    this.reachabilityCache.set(normalizedBaseUrl, {
      value,
      expiresAt: now + this.probeTtlMs,
    });
    return value;
  }

  async list() {
    const configuredWorkers = this.getConfiguredNodes();
    const liveWorkers = this.workerRegistry.list().map((worker) => ({
      ...worker,
      normalizedBaseUrl: normalizeWorkerBaseUrl(worker.baseUrl),
      configured: false,
      registered: true,
      source: "registered",
      configNodeName: null,
      hasAuthToken: Boolean(worker.authToken),
      registrationStatus: "registered",
    }));

    const workersByKey = new Map();
    for (const worker of configuredWorkers) {
      const key = worker.normalizedBaseUrl || worker.workerId;
      workersByKey.set(key, { ...worker });
    }

    for (const liveWorker of liveWorkers) {
      const key = liveWorker.normalizedBaseUrl || liveWorker.workerId;
      const existing = workersByKey.get(key);
      if (existing) {
        workersByKey.set(key, {
          ...existing,
          ...liveWorker,
          workerId: liveWorker.workerId,
          configured: true,
          registered: true,
          source: "configured+registered",
          configNodeName: existing.configNodeName,
          hasAuthToken: existing.hasAuthToken || liveWorker.hasAuthToken,
          registrationStatus: "registered",
          baseUrl: liveWorker.baseUrl || existing.baseUrl,
          normalizedBaseUrl: liveWorker.normalizedBaseUrl || existing.normalizedBaseUrl,
        });
        continue;
      }

      workersByKey.set(key, liveWorker);
    }

    const mergedWorkers = Array.from(workersByKey.values());
    await Promise.all(
      mergedWorkers.map(async (worker) => {
        if (!worker.configured || worker.registered) {
          worker.reachable = null;
          worker.reachabilityStatus = null;
          worker.reachabilityCheckedAt = null;
          worker.reachabilityError = null;
          return;
        }

        Object.assign(worker, await this.getReachability(worker));
      })
    );

    return mergedWorkers
      .map((worker) => sanitizeInventoryWorker(worker))
      .sort((a, b) => {
        const left = a.configNodeName || a.workerId || a.baseUrl || "";
        const right = b.configNodeName || b.workerId || b.baseUrl || "";
        return left.localeCompare(right);
      });
  }

  async get(workerId) {
    const workers = await this.list();
    return workers.find((worker) => worker.workerId === workerId) || null;
  }
}

module.exports = {
  DEFAULT_REACHABILITY_TIMEOUT_MS,
  DEFAULT_REACHABILITY_TTL_MS,
  WorkerInventory,
  loadConfiguredNodes,
  normalizeWorkerBaseUrl,
  probeReachability,
  readGlobalConfig,
  sanitizeInventoryWorker,
};
