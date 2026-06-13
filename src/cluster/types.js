function toIsoString(value) {
  return value ? new Date(value).toISOString() : null;
}

function createWindowRef(workerId, localWindowId) {
  return {
    workerId,
    localWindowId,
    id: `${workerId}:window:${localWindowId}`,
  };
}

function createAgentId(workerId, localWindowId) {
  return `${workerId}:agent:${localWindowId}`;
}

function createRuntimeSessionId(workerId, partition, accountIdx) {
  return `${workerId}:runtime:${partition || `account-${accountIdx}`}`;
}

module.exports = {
  toIsoString,
  createWindowRef,
  createAgentId,
  createRuntimeSessionId,
};
