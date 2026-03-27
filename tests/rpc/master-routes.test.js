const express = require("express");
const request = require("supertest");
const { createMasterRoutes } = require("../../src/master/master-routes");
const { WorkerRegistry } = require("../../src/master/worker-registry");
const { AgentIndex } = require("../../src/master/agent-index");
const { TaskStore } = require("../../src/master/task-store");
const { SessionAffinityStore } = require("../../src/master/session-affinity-store");
const { WorkerInventory } = require("../../src/master/worker-inventory");
const remoteExecutor = require("../../src/cluster/remote-executor");

describe("Master routes", () => {
  let app;
  let workerRegistry;
  let agentIndex;
  let taskStore;
  let sessionAffinityStore;
  let workerInventory;
  let forwardSpy;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    workerRegistry = new WorkerRegistry();
    agentIndex = new AgentIndex();
    taskStore = new TaskStore();
    sessionAffinityStore = new SessionAffinityStore();
    forwardSpy = jest.spyOn(remoteExecutor, "forwardJsonRequest");
    workerInventory = new WorkerInventory({
      workerRegistry,
      loadConfiguredNodesImpl: () => [],
      probeReachabilityImpl: async () => ({ reachable: false, reachabilityStatus: "unreachable" }),
    });

    app.use(
      "/api",
      createMasterRoutes({
        workerRegistry,
        workerInventory,
        agentIndex,
        taskStore,
        sessionAffinityStore,
        masterAuthMiddleware: (_req, _res, next) => next(),
      })
    );
  });

  afterEach(() => {
    forwardSpy.mockRestore();
  });

  test("registers worker and updates agent index", async () => {
    const response = await request(app)
      .post("/api/workers/register")
      .send({
        worker: { workerId: "worker-1", hostname: "test-host" },
        snapshot: {
          baseUrl: "http://127.0.0.1:18101",
          authToken: "worker-token",
          agents: [{ agentId: "worker-1:agent:1", status: "idle" }],
          resources: { pid: 123 },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.worker.workerId).toBe("worker-1");

    const workersResponse = await request(app).get("/api/workers");
    expect(workersResponse.body.workers).toHaveLength(1);

    const agentsResponse = await request(app).get("/api/agents");
    expect(agentsResponse.body.agents).toHaveLength(1);
    expect(agentsResponse.body.agents[0].workerId).toBe("worker-1");
  });

  test("accepts heartbeat for registered worker", async () => {
    await request(app)
      .post("/api/workers/register")
      .send({
        worker: { workerId: "worker-1", hostname: "test-host" },
        snapshot: {
          baseUrl: "http://127.0.0.1:18101",
          authToken: "worker-token",
        },
      });

    const heartbeat = await request(app)
      .post("/api/workers/heartbeat")
      .send({
        workerId: "worker-1",
        snapshot: {
          agents: [{ agentId: "worker-1:agent:2", status: "busy" }],
          resources: { pid: 456 },
        },
      });

    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.worker.workerId).toBe("worker-1");

    const workerDetail = await request(app).get("/api/workers/worker-1");
    expect(workerDetail.status).toBe(200);
    expect(workerDetail.body.agents).toHaveLength(1);
    expect(workerDetail.body.agents[0].agentId).toBe("worker-1:agent:2");
  });

  test("sanitizes auth tokens from worker inventory responses", async () => {
    await request(app)
      .post("/api/workers/register")
      .send({
        worker: { workerId: "worker-1", hostname: "test-host" },
        snapshot: {
          baseUrl: "http://127.0.0.1:18101",
          authToken: "worker-token",
        },
      });

    const workersResponse = await request(app).get("/api/workers");
    expect(workersResponse.status).toBe(200);
    expect(workersResponse.body.workers[0].authToken).toBeUndefined();

    const workerDetail = await request(app).get("/api/workers/worker-1");
    expect(workerDetail.status).toBe(200);
    expect(workerDetail.body.worker.authToken).toBeUndefined();
  });

  test("merges configured and registered workers by normalized baseUrl", async () => {
    workerInventory.loadConfiguredNodesImpl = () => [
      {
        workerId: "configured:windows",
        configNodeName: "windows",
        configured: true,
        registered: false,
        source: "configured",
        baseUrl: "http://localhost:18101/",
        normalizedBaseUrl: "http://127.0.0.1:18101",
        hasAuthToken: true,
        agents: [],
        capabilities: [],
        resources: null,
        lastHeartbeatAt: null,
        registeredAt: null,
        healthStatus: "offline",
        registrationStatus: "unregistered",
      },
    ];

    await request(app)
      .post("/api/workers/register")
      .send({
        worker: { workerId: "worker-1", hostname: "test-host" },
        snapshot: {
          baseUrl: "http://127.0.0.1:18101",
          authToken: "worker-token",
        },
      });

    const workersResponse = await request(app).get("/api/workers");
    expect(workersResponse.status).toBe(200);
    expect(workersResponse.body.workers).toHaveLength(1);
    expect(workersResponse.body.workers[0].source).toBe("configured+registered");
    expect(workersResponse.body.workers[0].configNodeName).toBe("windows");
  });

  test("includes configured-only workers and probes reachability", async () => {
    workerInventory.loadConfiguredNodesImpl = () => [
      {
        workerId: "configured:windows",
        configNodeName: "windows",
        configured: true,
        registered: false,
        source: "configured",
        baseUrl: "http://localhost:18101",
        normalizedBaseUrl: "http://127.0.0.1:18101",
        hasAuthToken: true,
        agents: [],
        capabilities: [],
        resources: null,
        lastHeartbeatAt: null,
        registeredAt: null,
        healthStatus: "offline",
        registrationStatus: "unregistered",
      },
    ];
    workerInventory.probeReachabilityImpl = jest.fn().mockResolvedValue({
      reachable: true,
      reachabilityStatus: "reachable",
      reachabilityCheckedAt: "2026-03-26T00:00:00.000Z",
      reachabilityError: null,
    });

    const workersResponse = await request(app).get("/api/workers");
    expect(workersResponse.status).toBe(200);
    expect(workersResponse.body.workers).toHaveLength(1);
    expect(workersResponse.body.workers[0].registered).toBe(false);
    expect(workersResponse.body.workers[0].reachable).toBe(true);
    expect(workerInventory.probeReachabilityImpl).toHaveBeenCalledWith("http://localhost:18101", {
      timeoutMs: workerInventory.probeTimeoutMs,
    });
  });

  test("preserves registered-only workers in merged inventory", async () => {
    await request(app)
      .post("/api/workers/register")
      .send({
        worker: { workerId: "worker-1", hostname: "test-host" },
        snapshot: {
          baseUrl: "http://127.0.0.1:18101",
          authToken: "worker-token",
        },
      });

    const workersResponse = await request(app).get("/api/workers");
    expect(workersResponse.status).toBe(200);
    expect(workersResponse.body.workers).toHaveLength(1);
    expect(workersResponse.body.workers[0].source).toBe("registered");
  });

  test("routes rpc call to worker and records task", async () => {
    workerRegistry.upsert({
      workerId: "worker-1",
      baseUrl: "http://127.0.0.1:18101",
      authToken: "worker-token",
      status: "online",
    });
    agentIndex.replaceWorkerAgents("worker-1", [
      {
        agentId: "worker-1:agent:1",
        runtimeSessionId: "worker-1:runtime:persist:sandbox-0",
        windowRef: { workerId: "worker-1", localWindowId: 1 },
        accountIdx: 0,
        status: "idle",
      },
    ]);

    forwardSpy.mockResolvedValue({
      result: {
        content: [{ type: "text", text: "pong" }],
      },
    });

    const response = await request(app).post("/api/rpc/ping").send({
      workerId: "worker-1",
      extra: true,
    });

    expect(response.status).toBe(200);
    expect(response.body.workerId).toBe("worker-1");
    expect(response.body.agentId).toBe("worker-1:agent:1");
    expect(response.body.runtimeSessionId).toBe("worker-1:runtime:persist:sandbox-0");
    expect(response.body.taskId).toBeDefined();
    expect(response.body.result.content[0].text).toBe("pong");
    expect(forwardSpy).toHaveBeenCalledWith("http://127.0.0.1:18101", "worker-token", "/rpc/ping", {
      extra: true,
      win_id: 1,
      agentId: "worker-1:agent:1",
      runtimeSessionId: "worker-1:runtime:persist:sandbox-0",
    });

    const tasksResponse = await request(app).get("/api/tasks");
    expect(tasksResponse.status).toBe(200);
    expect(tasksResponse.body.tasks).toHaveLength(1);
    expect(tasksResponse.body.tasks[0].status).toBe("completed");
    expect(tasksResponse.body.tasks[0].affinity.selectedBy).toBe("explicit-worker");
  });

  test("routes by control session affinity when workerId is omitted", async () => {
    workerRegistry.upsert({
      workerId: "worker-1",
      baseUrl: "http://127.0.0.1:18101",
      authToken: "worker-token",
      status: "online",
    });
    agentIndex.replaceWorkerAgents("worker-1", [
      {
        agentId: "worker-1:agent:1",
        runtimeSessionId: "worker-1:runtime:persist:sandbox-0",
        windowRef: { workerId: "worker-1", localWindowId: 1 },
        accountIdx: 0,
        status: "idle",
      },
    ]);

    forwardSpy.mockResolvedValue({
      result: {
        content: [{ type: "text", text: "pong" }],
      },
    });

    const first = await request(app)
      .post("/api/rpc/ping")
      .set("x-session-id", "control-1")
      .send({ extra: true });
    expect(first.status).toBe(200);
    expect(first.body.agentId).toBe("worker-1:agent:1");

    agentIndex.replaceWorkerAgents("worker-1", [
      {
        agentId: "worker-1:agent:1",
        runtimeSessionId: "worker-1:runtime:persist:sandbox-0",
        windowRef: { workerId: "worker-1", localWindowId: 1 },
        accountIdx: 0,
        status: "busy",
      },
    ]);

    const second = await request(app)
      .post("/api/rpc/ping")
      .set("x-session-id", "control-1")
      .send({ extra: false });
    expect(second.status).toBe(200);
    expect(second.body.agentId).toBe("worker-1:agent:1");

    const tasksResponse = await request(app).get("/api/tasks");
    expect(tasksResponse.body.tasks).toHaveLength(2);
    expect(tasksResponse.body.tasks[1].affinity.selectedBy).toBe("control-session-affinity");
  });
});
