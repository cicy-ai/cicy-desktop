// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

class AgentIndex {
  constructor() {
    this.agentsByWorker = new Map();
  }

  replaceWorkerAgents(workerId, agents = []) {
    this.agentsByWorker.set(
      workerId,
      agents.map((agent) => ({ ...agent, workerId }))
    );
  }

  list() {
    return Array.from(this.agentsByWorker.values())
      .flat()
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  listByWorker(workerId) {
    return this.agentsByWorker.get(workerId) || [];
  }
}

module.exports = { AgentIndex };
