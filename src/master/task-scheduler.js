function pickIdleAgent(agents = []) {
  return agents.find((agent) => agent.status === "idle") || agents[0] || null;
}

function findAgentByRuntimeSessionId(agents = [], runtimeSessionId) {
  return agents.find((agent) => agent.runtimeSessionId === runtimeSessionId) || null;
}

function findAgentByAccountIdx(agents = [], accountIdx) {
  return agents.find((agent) => agent.accountIdx === accountIdx && agent.status === "idle") || null;
}

function selectExecutionTarget({ request, workerRegistry, agentIndex, sessionAffinityStore }) {
  const workerId = request.workerId || null;
  const agentId = request.agentId || null;
  const runtimeSessionId = request.runtimeSessionId || null;
  const controlSessionId = request.controlSessionId || null;
  const accountIdx = request.accountIdx;

  if (workerId) {
    const worker = workerRegistry.get(workerId);
    if (!worker) throw new Error(`Worker '${workerId}' not found`);
    const agent = pickIdleAgent(agentIndex.listByWorker(workerId));
    return {
      workerId,
      worker,
      agentId: agent?.agentId || null,
      runtimeSessionId: agent?.runtimeSessionId || null,
      windowRef: agent?.windowRef || null,
      reason: "explicit-worker",
    };
  }

  if (agentId) {
    const agent = agentIndex.list().find((item) => item.agentId === agentId);
    if (!agent) throw new Error(`Agent '${agentId}' not found`);
    const worker = workerRegistry.get(agent.workerId);
    if (!worker) throw new Error(`Worker '${agent.workerId}' not found`);
    return {
      workerId: worker.workerId,
      worker,
      agentId: agent.agentId,
      runtimeSessionId: agent.runtimeSessionId,
      windowRef: agent.windowRef || null,
      reason: "explicit-agent",
    };
  }

  if (runtimeSessionId) {
    const agent = findAgentByRuntimeSessionId(agentIndex.list(), runtimeSessionId);
    if (agent) {
      const worker = workerRegistry.get(agent.workerId);
      if (worker) {
        return {
          workerId: worker.workerId,
          worker,
          agentId: agent.agentId,
          runtimeSessionId: agent.runtimeSessionId,
          windowRef: agent.windowRef || null,
          reason: "explicit-runtime-session",
        };
      }
    }
  }

  if (controlSessionId) {
    const affinity = sessionAffinityStore.get(controlSessionId);
    if (affinity?.agentId) {
      const agent = agentIndex.list().find((item) => item.agentId === affinity.agentId);
      if (agent) {
        const worker = workerRegistry.get(agent.workerId);
        if (worker) {
          return {
            workerId: worker.workerId,
            worker,
            agentId: agent.agentId,
            runtimeSessionId: agent.runtimeSessionId,
            windowRef: agent.windowRef || null,
            reason: "control-session-affinity",
          };
        }
      }
    }

    if (affinity?.runtimeSessionId) {
      const agent = findAgentByRuntimeSessionId(agentIndex.list(), affinity.runtimeSessionId);
      if (agent) {
        const worker = workerRegistry.get(agent.workerId);
        if (worker) {
          return {
            workerId: worker.workerId,
            worker,
            agentId: agent.agentId,
            runtimeSessionId: agent.runtimeSessionId,
            windowRef: agent.windowRef || null,
            reason: "runtime-session-affinity",
          };
        }
      }
    }
  }

  if (accountIdx !== undefined) {
    const agent = findAgentByAccountIdx(agentIndex.list(), accountIdx);
    if (agent) {
      const worker = workerRegistry.get(agent.workerId);
      if (worker) {
        return {
          workerId: worker.workerId,
          worker,
          agentId: agent.agentId,
          runtimeSessionId: agent.runtimeSessionId,
          windowRef: agent.windowRef || null,
          reason: "account-affinity",
        };
      }
    }
  }

  const workers = workerRegistry.list().filter((worker) => worker.status === "online");
  for (const worker of workers) {
    const agent = pickIdleAgent(agentIndex.listByWorker(worker.workerId));
    if (agent) {
      return {
        workerId: worker.workerId,
        worker,
        agentId: agent.agentId,
        runtimeSessionId: agent.runtimeSessionId,
        windowRef: agent.windowRef || null,
        reason: "idle-agent-fallback",
      };
    }
  }

  const worker = workers[0];
  if (worker) {
    return {
      workerId: worker.workerId,
      worker,
      agentId: null,
      runtimeSessionId: null,
      windowRef: null,
      reason: "worker-fallback",
    };
  }

  throw new Error("No online worker available");
}

module.exports = { selectExecutionTarget };
