class TaskStore {
  constructor() {
    this.tasks = new Map();
  }

  create(task) {
    const record = {
      taskId: task.taskId,
      workerId: task.workerId || null,
      agentId: task.agentId || null,
      runtimeSessionId: task.runtimeSessionId || null,
      windowRef: task.windowRef || null,
      controlSessionId: task.controlSessionId || null,
      accountIdx: task.accountIdx ?? null,
      toolName: task.toolName,
      args: task.args || {},
      affinity: task.affinity || null,
      attempt: task.attempt || 1,
      status: task.status || "pending",
      createdAt: task.createdAt || new Date().toISOString(),
      assignedAt: task.assignedAt || null,
      startedAt: task.startedAt || null,
      completedAt: task.completedAt || null,
      updatedAt: new Date().toISOString(),
      result: task.result || null,
      error: task.error || null,
    };
    this.tasks.set(record.taskId, record);
    return record;
  }

  update(taskId, patch) {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  list() {
    return Array.from(this.tasks.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

module.exports = { TaskStore };
