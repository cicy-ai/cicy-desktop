const express = require("express");
const request = require("supertest");
const { WorkerRegistry } = require("../../src/master/worker-registry");
const { AgentIndex } = require("../../src/master/agent-index");
const { TaskStore } = require("../../src/master/task-store");
const { SessionAffinityStore } = require("../../src/master/session-affinity-store");
const { createMasterAdminRoutes } = require("../../src/master/master-admin-routes");
const { createWorkerObservabilityRoutes } = require("../../src/server/worker-observability-routes");

describe("Phase 4 observability", () => {
  test("worker registry derives stale and offline health", () => {
    const registry = new WorkerRegistry();
    const now = Date.now();

    registry.upsert({ workerId: "w-online", lastHeartbeatAt: new Date(now).toISOString() });
    registry.upsert({ workerId: "w-stale", lastHeartbeatAt: new Date(now - 20000).toISOString() });
    registry.upsert({
      workerId: "w-offline",
      lastHeartbeatAt: new Date(now - 40000).toISOString(),
    });

    expect(registry.get("w-online").healthStatus).toBe("online");
    expect(registry.get("w-stale").healthStatus).toBe("stale");
    expect(registry.get("w-offline").healthStatus).toBe("offline");
  });

  test("master admin routes expose summary and collections", async () => {
    const app = express();
    const workerRegistry = new WorkerRegistry();
    const agentIndex = new AgentIndex();
    const taskStore = new TaskStore();
    const sessionAffinityStore = new SessionAffinityStore();

    workerRegistry.upsert({
      workerId: "worker-1",
      lastHeartbeatAt: new Date().toISOString(),
      resources: { memory: { rss: 123 } },
      capabilities: ["ping", "get_windows"],
      agents: [{ agentId: "worker-1:agent:1" }],
    });
    agentIndex.replaceWorkerAgents("worker-1", [
      {
        agentId: "worker-1:agent:1",
        workerId: "worker-1",
        status: "idle",
        runtimeSessionId: "rs-1",
        accountIdx: 0,
      },
    ]);
    taskStore.create({
      taskId: "task-1",
      toolName: "ping",
      status: "completed",
      workerId: "worker-1",
      agentId: "worker-1:agent:1",
    });
    sessionAffinityStore.bind("control-1", {
      workerId: "worker-1",
      agentId: "worker-1:agent:1",
      runtimeSessionId: "rs-1",
    });

    app.use(
      "/admin",
      createMasterAdminRoutes({ workerRegistry, agentIndex, taskStore, sessionAffinityStore })
    );

    const summary = await request(app).get("/admin/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.workers.total).toBe(1);
    expect(summary.body.agents.total).toBe(1);
    expect(summary.body.tasks.total).toBe(1);
    expect(summary.body.sessions.total).toBe(1);

    const workers = await request(app).get("/admin/workers");
    expect(workers.status).toBe(200);
    expect(workers.body.workers[0].healthStatus).toBe("online");

    const sessions = await request(app).get("/admin/sessions");
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toHaveLength(1);
  });

  test("worker observability routes expose health and summary", async () => {
    const app = express();
    app.use(
      "/observability",
      createWorkerObservabilityRoutes({
        getWorkerIdentity: () => ({ workerId: "worker-1", pid: 123 }),
        getWorkerSnapshot: () => ({
          agents: [{ agentId: "worker-1:agent:1" }],
          artifacts: [{ artifactId: "artifact-1" }],
          capabilities: ["ping"],
          resources: { memory: { rss: 456 }, uptime: 78 },
        }),
      })
    );

    const health = await request(app).get("/observability/healthz");
    expect(health.status).toBe(200);
    expect(health.body.workerId).toBe("worker-1");
    expect(health.body.agents).toBe(1);

    const summary = await request(app).get("/observability/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.snapshot.capabilities).toEqual(["ping"]);

    const metrics = await request(app).get("/observability/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain("cicy_worker_up 1");
  });
});
