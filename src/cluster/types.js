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

function createArtifactId(workerId, kind, localId) {
  return `${workerId}:artifact:${kind}:${localId}`;
}

module.exports = {
  toIsoString,
  createWindowRef,
  createAgentId,
  createRuntimeSessionId,
  createArtifactId,
};
