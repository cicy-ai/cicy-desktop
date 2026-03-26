const express = require("express");

function createWorkerObservabilityRoutes({ getWorkerIdentity, getWorkerSnapshot }) {
  const router = express.Router();

  router.get("/healthz", (req, res) => {
    const snapshot = getWorkerSnapshot();
    res.json({
      status: "ok",
      workerId: getWorkerIdentity().workerId,
      ts: Date.now(),
      agents: snapshot.agents.length,
      artifacts: snapshot.artifacts.length,
    });
  });

  router.get("/readyz", (req, res) => {
    res.json({ status: "ready", workerId: getWorkerIdentity().workerId, ts: Date.now() });
  });

  router.get("/metrics", (req, res) => {
    const identity = getWorkerIdentity();
    const snapshot = getWorkerSnapshot();
    const lines = [
      `cicy_worker_up 1`,
      `cicy_worker_agents ${snapshot.agents.length}`,
      `cicy_worker_artifacts ${snapshot.artifacts.length}`,
      `cicy_worker_capabilities ${snapshot.capabilities.length}`,
      `cicy_worker_memory_rss ${snapshot.resources.memory.rss || 0}`,
      `cicy_worker_uptime ${snapshot.resources.uptime || 0}`,
      `cicy_worker_pid ${identity.pid || 0}`,
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  router.get("/summary", (req, res) => {
    const identity = getWorkerIdentity();
    const snapshot = getWorkerSnapshot();
    res.json({
      worker: identity,
      snapshot,
    });
  });

  return router;
}

module.exports = { createWorkerObservabilityRoutes };
