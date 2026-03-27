const { getWorkerIdentity } = require("../cluster/worker-identity");
const { createRuntimeSessionId } = require("../cluster/types");

class ChromeRuntimeRegistry {
  constructor() {
    this.runtimes = new Map();
  }

  upsert(accountIdx, patch = {}) {
    const now = new Date().toISOString();
    const existing = this.runtimes.get(accountIdx) || this.createBaseRuntime(accountIdx);
    const next = {
      ...existing,
      ...patch,
      accountIdx,
      lastSeenAt: patch.lastSeenAt || now,
      updatedAt: now,
    };
    this.runtimes.set(accountIdx, next);
    return next;
  }

  createBaseRuntime(accountIdx) {
    const { workerId } = getWorkerIdentity();
    const runtimeKey = `chrome-account-${accountIdx}`;
    return {
      accountIdx,
      workerId,
      runtimeType: "chrome-profile",
      runtimeSessionId: createRuntimeSessionId(workerId, runtimeKey, accountIdx),
      status: "stopped",
      startedAt: null,
      lastSeenAt: null,
      updatedAt: null,
      pid: null,
      proxy: null,
      debuggerPort: null,
      webSocketDebuggerUrl: null,
      profileDirectory: "Default",
      userDataDirRoot: null,
      chromeBinary: null,
      url: null,
      error: null,
    };
  }

  get(accountIdx) {
    return this.runtimes.get(accountIdx) || null;
  }

  list() {
    return Array.from(this.runtimes.values()).sort((a, b) => a.accountIdx - b.accountIdx);
  }

  markStopped(accountIdx, patch = {}) {
    return this.upsert(accountIdx, {
      status: "stopped",
      pid: null,
      webSocketDebuggerUrl: null,
      startedAt: null,
      url: null,
      error: null,
      ...patch,
    });
  }

  delete(accountIdx) {
    this.runtimes.delete(accountIdx);
  }
}

if (!global.__cicyChromeRuntimeRegistry) {
  global.__cicyChromeRuntimeRegistry = new ChromeRuntimeRegistry();
}

function getChromeRuntimeRegistry() {
  return global.__cicyChromeRuntimeRegistry;
}

module.exports = {
  ChromeRuntimeRegistry,
  getChromeRuntimeRegistry,
};
