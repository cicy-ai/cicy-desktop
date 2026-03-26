const express = require("express");
const path = require("path");
const { WorkerRegistry } = require("./worker-registry");
const { AgentIndex } = require("./agent-index");
const { TaskStore } = require("./task-store");
const { SessionAffinityStore } = require("./session-affinity-store");
const { MasterTokenManager } = require("./master-token-manager");
const { createMasterRoutes } = require("./master-routes");
const { createMasterAdminRoutes } = require("./master-admin-routes");

function createMasterAuthMiddleware(masterToken) {
  return (req, res, next) => {
    const queryToken = req.query?.token;
    if (queryToken && queryToken === masterToken) {
      return next();
    }

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.slice("Bearer ".length);
    if (token !== masterToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  };
}

function startMasterServer({ port = 8100, masterToken = process.env.CICY_MASTER_TOKEN } = {}) {
  const tokenManager = new MasterTokenManager();
  const resolvedMasterToken = masterToken || tokenManager.getToken();
  const app = express();
  app.use(express.json());

  const workerRegistry = new WorkerRegistry();
  const agentIndex = new AgentIndex();
  const taskStore = new TaskStore();
  const sessionAffinityStore = new SessionAffinityStore();
  const masterAuthMiddleware = createMasterAuthMiddleware(resolvedMasterToken);

  app.use(
    "/api",
    createMasterRoutes({
      workerRegistry,
      agentIndex,
      taskStore,
      sessionAffinityStore,
      masterAuthMiddleware,
    })
  );

  app.use(
    "/admin",
    masterAuthMiddleware,
    createMasterAdminRoutes({
      workerRegistry,
      agentIndex,
      taskStore,
      sessionAffinityStore,
    })
  );

  app.get("/master", masterAuthMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, "master-admin.html"));
  });

  const server = app.listen(port, () => {
    console.log(`[Master] listening on http://localhost:${port}`);
    console.log(`[Master] token file: ${tokenManager.getConfigPath()}`);
  });

  return {
    app,
    server,
    state: { workerRegistry, agentIndex, taskStore, sessionAffinityStore },
    masterToken: resolvedMasterToken,
    tokenPath: tokenManager.getConfigPath(),
  };
}

if (require.main === module) {
  const port = Number(process.env.MASTER_PORT || process.env.PORT || 8100);
  const { server } = startMasterServer({ port });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { startMasterServer, createMasterAuthMiddleware, MasterTokenManager };
