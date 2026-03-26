const { BrowserWindow } = require("electron");
const { getWindowInfo } = require("../utils/window-utils");
const { getWorkerIdentity } = require("./worker-identity");
const { createAgentId, createRuntimeSessionId, createWindowRef } = require("./types");

function mapWindowToAgent(win) {
  const windowInfo = getWindowInfo(win);
  if (!windowInfo) return null;

  const { workerId } = getWorkerIdentity();
  const windowRef = createWindowRef(workerId, windowInfo.id);
  const status = windowInfo.isDestroyed
    ? "offline"
    : windowInfo.isCrashed
      ? "error"
      : windowInfo.isLoading
        ? "busy"
        : "idle";

  return {
    agentId: createAgentId(workerId, windowInfo.id),
    workerId,
    status,
    accountIdx: windowInfo.accountIdx,
    partition: windowInfo.partition,
    runtimeSessionId: createRuntimeSessionId(workerId, windowInfo.partition, windowInfo.accountIdx),
    windowRef,
    window: windowInfo,
    updatedAt: new Date().toISOString(),
  };
}

function listLocalAgents() {
  return BrowserWindow.getAllWindows().map(mapWindowToAgent).filter(Boolean);
}

module.exports = {
  mapWindowToAgent,
  listLocalAgents,
};
