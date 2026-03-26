const express = require("express");
const { randomUUID } = require("crypto");
const remoteExecutor = require("../cluster/remote-executor");
const { selectExecutionTarget } = require("./task-scheduler");

function createMasterRoutes({
  workerRegistry,
  agentIndex,
  taskStore,
  sessionAffinityStore,
  masterAuthMiddleware,
}) {
  const router = express.Router();

  router.get("/ping", (req, res) => {
    res.json({ ping: "pong", ts: Date.now() });
  });

  router.post("/workers/register", masterAuthMiddleware, (req, res) => {
    const { worker, snapshot = {} } = req.body || {};
    if (!worker?.workerId) {
      return res.status(400).json({ error: "worker.workerId required" });
    }

    const record = workerRegistry.upsert({
      ...worker,
      status: "online",
      agents: snapshot.agents || [],
      resources: snapshot.resources || {},
      capabilities: snapshot.capabilities || [],
      baseUrl: snapshot.baseUrl || worker.baseUrl,
      authToken: snapshot.authToken || worker.authToken,
      lastHeartbeatAt: new Date().toISOString(),
    });
    agentIndex.replaceWorkerAgents(worker.workerId, snapshot.agents || []);
    res.json({ worker: record });
  });

  router.post("/workers/heartbeat", masterAuthMiddleware, (req, res) => {
    const { workerId, snapshot = {} } = req.body || {};
    if (!workerId) {
      return res.status(400).json({ error: "workerId required" });
    }

    const record = workerRegistry.markHeartbeat(workerId, {
      agents: snapshot.agents || [],
      resources: snapshot.resources || {},
      capabilities: snapshot.capabilities || [],
      baseUrl: snapshot.baseUrl,
      authToken: snapshot.authToken,
    });
    agentIndex.replaceWorkerAgents(workerId, snapshot.agents || []);
    res.json({ worker: record });
  });

  router.get("/workers", (req, res) => {
    res.json({ workers: workerRegistry.list() });
  });

  router.get("/workers/:workerId", (req, res) => {
    const worker = workerRegistry.get(req.params.workerId);
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    res.json({ worker, agents: agentIndex.listByWorker(req.params.workerId) });
  });

  router.get("/agents", (req, res) => {
    res.json({ agents: agentIndex.list() });
  });

  router.get("/tasks", (req, res) => {
    res.json({ tasks: taskStore.list() });
  });

  router.get("/tasks/:taskId", (req, res) => {
    const task = taskStore.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ task });
  });

  router.get("/stats", (req, res) => {
    res.json({
      workers: workerRegistry.list().length,
      agents: agentIndex.list().length,
      tasks: taskStore.list().length,
    });
  });

  router.post("/rpc/:toolName", async (req, res) => {
    const requestContext = {
      workerId: req.body?.workerId || req.query.workerId || null,
      agentId: req.body?.agentId || req.query.agentId || null,
      runtimeSessionId: req.body?.runtimeSessionId || req.query.runtimeSessionId || null,
      controlSessionId: req.body?.controlSessionId || req.headers["x-session-id"] || null,
      accountIdx: req.body?.accountIdx,
    };

    let target;
    try {
      target = selectExecutionTarget({
        request: requestContext,
        workerRegistry,
        agentIndex,
        sessionAffinityStore,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const task = taskStore.create({
      taskId: randomUUID(),
      workerId: target.workerId,
      agentId: target.agentId,
      runtimeSessionId: target.runtimeSessionId,
      windowRef: target.windowRef,
      controlSessionId: requestContext.controlSessionId,
      accountIdx: requestContext.accountIdx,
      toolName: req.params.toolName,
      args: req.body || {},
      affinity: {
        input: requestContext,
        selectedBy: target.reason,
      },
      status: "assigned",
      assignedAt: new Date().toISOString(),
    });

    try {
      const payload = { ...(req.body || {}) };
      delete payload.workerId;
      if (target.windowRef?.localWindowId && payload.win_id === undefined) {
        payload.win_id = target.windowRef.localWindowId;
      }
      if (target.agentId && payload.agentId === undefined) {
        payload.agentId = target.agentId;
      }
      if (target.runtimeSessionId && payload.runtimeSessionId === undefined) {
        payload.runtimeSessionId = target.runtimeSessionId;
      }

      taskStore.update(task.taskId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      const data = await remoteExecutor.forwardJsonRequest(
        target.worker.baseUrl,
        target.worker.authToken,
        `/rpc/${req.params.toolName}`,
        payload
      );

      taskStore.update(task.taskId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        result: data.result || null,
      });

      if (requestContext.controlSessionId) {
        sessionAffinityStore.bind(requestContext.controlSessionId, {
          workerId: target.workerId,
          agentId: target.agentId,
          runtimeSessionId: target.runtimeSessionId,
          windowRef: target.windowRef,
        });
      }

      res.json({
        taskId: task.taskId,
        workerId: target.workerId,
        agentId: target.agentId,
        runtimeSessionId: target.runtimeSessionId,
        result: data.result || null,
      });
    } catch (error) {
      taskStore.update(task.taskId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error.message,
      });
      res.status(502).json({
        error: error.message,
        taskId: task.taskId,
        workerId: target.workerId,
        agentId: target.agentId,
        runtimeSessionId: target.runtimeSessionId,
      });
    }
  });

  return router;
}

module.exports = { createMasterRoutes };
