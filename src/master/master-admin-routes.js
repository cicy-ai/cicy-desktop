const express = require("express");
const {
  getClusterSummary,
  getWorkerAdminView,
  renderPrometheusMetrics,
} = require("./master-metrics");

function createMasterAdminRoutes({ workerRegistry, agentIndex, taskStore, sessionAffinityStore }) {
  const router = express.Router();

  router.get("/summary", (req, res) => {
    res.json(
      getClusterSummary({
        workerRegistry,
        agentIndex,
        taskStore,
        sessionAffinityStore,
      })
    );
  });

  router.get("/workers", (req, res) => {
    res.json({ workers: getWorkerAdminView(workerRegistry) });
  });

  router.get("/agents", (req, res) => {
    res.json({ agents: agentIndex.list() });
  });

  router.get("/tasks", (req, res) => {
    res.json({ tasks: taskStore.list().slice(-100).reverse() });
  });

  router.get("/sessions", (req, res) => {
    res.json({ sessions: sessionAffinityStore.list ? sessionAffinityStore.list() : [] });
  });

  router.get("/metrics", (req, res) => {
    const summary = getClusterSummary({
      workerRegistry,
      agentIndex,
      taskStore,
      sessionAffinityStore,
    });
    res.type("text/plain").send(renderPrometheusMetrics(summary));
  });

  router.get("/healthz", (req, res) => {
    res.json({ status: "ok", ts: Date.now() });
  });

  router.get("/readyz", (req, res) => {
    res.json({ status: "ready", ts: Date.now() });
  });

  return router;
}

module.exports = { createMasterAdminRoutes };
