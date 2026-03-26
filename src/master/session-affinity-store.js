class SessionAffinityStore {
  constructor() {
    this.byControlSessionId = new Map();
  }

  bind(controlSessionId, value) {
    if (!controlSessionId) return null;
    const record = {
      controlSessionId,
      ...value,
      updatedAt: new Date().toISOString(),
    };
    this.byControlSessionId.set(controlSessionId, record);
    return record;
  }

  get(controlSessionId) {
    return this.byControlSessionId.get(controlSessionId) || null;
  }

  clearByAgent(agentId) {
    for (const [key, value] of this.byControlSessionId.entries()) {
      if (value.agentId === agentId) {
        this.byControlSessionId.delete(key);
      }
    }
  }

  list() {
    return Array.from(this.byControlSessionId.values()).sort((a, b) =>
      a.controlSessionId.localeCompare(b.controlSessionId)
    );
  }
}

module.exports = { SessionAffinityStore };
