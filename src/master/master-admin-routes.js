const express = require("express");
const {
  getClusterSummary,
  getWorkerAdminView,
  renderPrometheusMetrics,
} = require("./master-metrics");

function createMasterAdminRoutes({
  workerRegistry,
  workerInventory,
  agentIndex,
  taskStore,
  sessionAffinityStore,
}) {
  const router = express.Router();

  router.get("/summary", async (_req, res) => {
    res.json(
      await getClusterSummary({
        workerRegistry,
        workerInventory,
        agentIndex,
        taskStore,
        sessionAffinityStore,
      })
    );
  });

  router.get("/workers", async (_req, res) => {
    const workers = workerInventory ? await workerInventory.list() : workerRegistry.list();
    res.json({ workers: getWorkerAdminView({ workers }) });
  });

  router.get("/agents", (_req, res) => {
    res.json({ agents: agentIndex.list() });
  });

  router.get("/tasks", (_req, res) => {
    res.json({ tasks: taskStore.list().slice(-100).reverse() });
  });

  router.get("/sessions", (_req, res) => {
    res.json({ sessions: sessionAffinityStore.list ? sessionAffinityStore.list() : [] });
  });

  router.get("/metrics", async (_req, res) => {
    const summary = await getClusterSummary({
      workerRegistry,
      workerInventory,
      agentIndex,
      taskStore,
      sessionAffinityStore,
    });
    res.type("text/plain").send(renderPrometheusMetrics(summary));
  });

  router.get("/healthz", (_req, res) => {
    res.json({ status: "ok", ts: Date.now() });
  });

  router.get("/readyz", (_req, res) => {
    res.json({ status: "ready", ts: Date.now() });
  });

  return router;
}

module.exports = { createMasterAdminRoutes };
