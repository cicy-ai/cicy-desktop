function formatMemory(memory = {}) {
  return {
    rss: memory?.rss || 0,
    heapTotal: memory?.heapTotal || 0,
    heapUsed: memory?.heapUsed || 0,
    external: memory?.external || 0,
    arrayBuffers: memory?.arrayBuffers || 0,
  };
}

function getWorkerHealthStatus(
  worker,
  now = Date.now(),
  staleAfterMs = 15000,
  offlineAfterMs = 30000
) {
  if (!worker?.lastHeartbeatAt) {
    return "offline";
  }

  const ageMs = now - new Date(worker.lastHeartbeatAt).getTime();
  if (ageMs >= offlineAfterMs) return "offline";
  if (ageMs >= staleAfterMs) return "stale";
  return "online";
}

function getWorkerAdminView({ workers = [] } = {}) {
  const now = Date.now();
  return workers.map((worker) => ({
    ...worker,
    healthStatus: worker.registered
      ? worker.healthStatus || getWorkerHealthStatus(worker, now)
      : "offline",
    resources: worker.resources
      ? {
          ...worker.resources,
          memory: formatMemory(worker.resources.memory),
        }
      : null,
  }));
}

async function getClusterSummary({
  workerRegistry,
  workerInventory,
  agentIndex,
  taskStore,
  sessionAffinityStore,
}) {
  const workers = workerInventory ? await workerInventory.list() : workerRegistry.list();
  const agents = agentIndex.list();
  const tasks = taskStore.list();
  const sessions = sessionAffinityStore.list ? sessionAffinityStore.list() : [];

  const workerHealth = workers.reduce(
    (acc, worker) => {
      acc.total += 1;
      if (worker.registered) {
        const status = worker.healthStatus || getWorkerHealthStatus(worker);
        acc[status] += 1;
        acc.registered += 1;
      } else {
        acc.configuredOnly += 1;
        if (worker.reachable) acc.reachableConfiguredOnly += 1;
      }
      return acc;
    },
    {
      total: 0,
      registered: 0,
      configuredOnly: 0,
      reachableConfiguredOnly: 0,
      online: 0,
      stale: 0,
      offline: 0,
    }
  );

  const agentHealth = agents.reduce(
    (acc, agent) => {
      acc.total += 1;
      const status = agent.status || "unknown";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    },
    { total: 0, idle: 0, busy: 0, error: 0, offline: 0 }
  );

  const taskHealth = tasks.reduce(
    (acc, task) => {
      acc.total += 1;
      const status = task.status || "unknown";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    },
    {
      total: 0,
      pending: 0,
      assigned: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timeout: 0,
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    workers: workerHealth,
    agents: agentHealth,
    tasks: taskHealth,
    sessions: {
      total: sessions.length,
    },
  };
}

function renderPrometheusMetrics(summary) {
  return [
    `cicy_workers_total ${summary.workers.total}`,
    `cicy_workers_registered ${summary.workers.registered || 0}`,
    `cicy_workers_configured_only ${summary.workers.configuredOnly || 0}`,
    `cicy_workers_configured_only_reachable ${summary.workers.reachableConfiguredOnly || 0}`,
    `cicy_workers_online ${summary.workers.online}`,
    `cicy_workers_stale ${summary.workers.stale}`,
    `cicy_workers_offline ${summary.workers.offline}`,
    `cicy_agents_total ${summary.agents.total}`,
    `cicy_agents_idle ${summary.agents.idle || 0}`,
    `cicy_agents_busy ${summary.agents.busy || 0}`,
    `cicy_tasks_total ${summary.tasks.total}`,
    `cicy_tasks_running ${summary.tasks.running || 0}`,
    `cicy_tasks_completed ${summary.tasks.completed || 0}`,
    `cicy_tasks_failed ${summary.tasks.failed || 0}`,
    `cicy_sessions_total ${summary.sessions.total}`,
  ].join("\n");
}

module.exports = {
  formatMemory,
  getWorkerHealthStatus,
  getClusterSummary,
  getWorkerAdminView,
  renderPrometheusMetrics,
};
