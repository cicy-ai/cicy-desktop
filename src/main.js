const { app: electronApp } = require("electron");
const { default: contextMenu } = require("electron-context-menu");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 🎯 添加右键上下文菜单
contextMenu({
  showLookUpSelection: true,
  showSearchWithGoogle: true,
  showCopyImage: true,
  showCopyImageAddress: true,
  showSaveImageAs: true,
  showCopyVideoAddress: true,
  showSaveVideoAs: true,
  showCopyLink: true,
  showSaveLinkAs: true,
  showInspectElement: true,
  showServices: true,
  labels: {
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    reload: "重新加载",
    forceReload: "强制重新加载",
    toggleDevTools: "切换开发者工具",
    inspectElement: "检查元素",
    services: "服务",
    lookUpSelection: "查找选中内容",
    searchWithGoogle: "用 Google 搜索",
    copyImage: "复制图片",
    copyImageAddress: "复制图片地址",
    saveImage: "保存图片",
    copyVideoAddress: "复制视频地址",
    saveVideo: "保存视频",
    copyLink: "复制链接",
    saveLinkAs: "链接另存为...",
  },
});

// Setup Electron flags IMMEDIATELY after require
electronApp.commandLine.appendSwitch("ignore-certificate-errors");
if (process.platform === "linux") {
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
  // electronApp.commandLine.appendSwitch("disable-setuid-sandbox");
  electronApp.commandLine.appendSwitch("log-level", "3");
  electronApp.commandLine.appendSwitch("disable-notifications");
  electronApp.commandLine.appendSwitch("ignore-certificate-errors");
  if (process.env.ELECTRON_DISABLE_HTTP_CACHE === "1") {
    electronApp.commandLine.appendSwitch("disable-http-cache");
    electronApp.commandLine.appendSwitch("disable-application-cache");
  }
  electronApp.commandLine.appendSwitch("disable-geolocation");
  electronApp.commandLine.appendSwitch("disable-dev-shm-usage");
  electronApp.commandLine.appendSwitch("use-gl", "angle");
  electronApp.commandLine.appendSwitch("use-angle", "swiftshader");
}

const http = require("http");
const log = require("electron-log");
const { config } = require("./config");
const { createWindow } = require("./utils/window-utils");
const { AuthManager } = require("./utils/auth");
const { setupElectronFlags, setupErrorHandlers } = require("./server/electron-setup");
const { parseArgs } = require("./server/args-parser");
const { setupLogging, wrapLogger } = require("./server/logging");
const { createExpressApp } = require("./server/express-app");
const { createWorkerObservabilityRoutes } = require("./server/worker-observability-routes");
const { createMcpServer, setupMcpRoutes } = require("./server/mcp-server");
const { registerTool } = require("./server/tool-registry");
const { loadToolCatalog } = require("./server/tool-catalog");
const { executeTool } = require("./server/tool-executor");
const { getWorkerIdentity } = require("./cluster/worker-identity");
const { listLocalAgents } = require("./cluster/local-agent-registry");
const { listArtifacts } = require("./cluster/artifact-registry");
const { WorkerClient } = require("./cluster/worker-client");

// Setup
// setupElectronFlags(); // Already done above
setupErrorHandlers();

// Parse arguments
const { PORT, START_URL, PROXY, oneWindow, ACCOUNT } = parseArgs();
config.port = PORT;
if (PROXY) {
  config.proxy = PROXY;
  log.info(`[MCP] Global proxy enabled: ${PROXY}`);
}
if (oneWindow) {
  config.oneWindow = true;
  log.info("[MCP] Single window mode enabled");
}

// Setup logging
setupLogging(config);
wrapLogger();

log.info("[MCP] Server starting at", new Date().toISOString());

// Initialize auth
const authManager = new AuthManager();
global.authManager = authManager; // Make it globally accessible
const authMiddleware = (req, res, next) => {
  if (!authManager.validateAuth(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="CiCy Desktop"');
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// Create servers
const mcpServer = createMcpServer();
const toolCatalog = loadToolCatalog();
const tools = {};
const app = createExpressApp(authMiddleware, tools);

// Register tools
Array.from(toolCatalog.toolsByName.values()).forEach((tool) => {
  registerTool(
    mcpServer,
    tools,
    tool.name,
    tool.description,
    tool.schema,
    tool.handler,
    tool.options
  );
});

// Setup MCP routes
setupMcpRoutes(app, mcpServer, authMiddleware);

function parseYamlBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        const yaml = require("js-yaml");
        resolve(yaml.load(data) || {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function buildRequestContext(req, extra = {}) {
  return {
    transport: extra.transport || "rest",
    requestId: req.headers["x-request-id"] || null,
    controlSessionId:
      req.headers["x-session-id"] || req.query.sessionId || req.body?.sessionId || null,
    agentId: req.headers["x-agent-id"] || req.query.agentId || req.body?.agentId || null,
    runtimeSessionId:
      req.headers["x-runtime-session-id"] ||
      req.query.runtimeSessionId ||
      req.body?.runtimeSessionId ||
      null,
    windowRef: req.body?.windowRef || null,
    accountIdx: req.body?.accountIdx,
    worker: getWorkerIdentity(),
    ...extra,
  };
}

function sendToolResponse(req, res, result) {
  const accept = req.headers.accept || "application/json";
  if (accept.includes("application/yaml") || accept.includes("text/yaml")) {
    const yaml = require("js-yaml");
    res.type("yaml").send(yaml.dump({ result }));
  } else {
    res.json({ result });
  }
}

function sendExecutionError(res, error) {
  if (error.name === "ZodError") {
    const errorMsg = error.errors.map((e) => e.message).join(", ");
    return res.json({
      result: {
        content: [{ type: "text", text: errorMsg }],
        isError: true,
      },
    });
  }

  res.status(500).json({ error: error.message });
}

function getWorkerSnapshot(authManager) {
  return {
    baseUrl: `http://127.0.0.1:${config.port}`,
    authToken: authManager.getToken(),
    capabilities: Object.values(tools)
      .flat()
      .map((tool) => tool.name),
    agents: listLocalAgents(),
    artifacts: listArtifacts(),
    resources: {
      pid: process.pid,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
    },
  };
}

app.use(
  "/observability",
  createWorkerObservabilityRoutes({
    getWorkerIdentity,
    getWorkerSnapshot: () => getWorkerSnapshot(authManager),
  })
);

function maybeCreateWorkerClient(authManager) {
  const masterUrl = process.env.CICY_MASTER_URL;
  const workerToken = process.env.CICY_MASTER_TOKEN;
  if (!masterUrl || !workerToken) return null;

  return new WorkerClient({
    masterUrl,
    workerToken,
    workerIdentity: getWorkerIdentity(),
    getStatusSnapshot: () => getWorkerSnapshot(authManager),
  });
}

app.get("/api/worker", authMiddleware, (req, res) => {
  res.json({ worker: getWorkerIdentity() });
});

app.get("/api/agents", authMiddleware, (req, res) => {
  res.json({ agents: listLocalAgents() });
});

app.get("/api/artifacts", authMiddleware, (req, res) => {
  res.json({ artifacts: listArtifacts() });
});

// RPC endpoint with hot reload
app.post("/rpc/tools/call", authMiddleware, async (req, res) => {
  let body = req.body;

  if (req.get("Content-Type")?.includes("application/yaml")) {
    try {
      body = await parseYamlBody(req);
    } catch (error) {
      return res.status(400).json({ error: `Invalid YAML: ${error.message}` });
    }
  }

  const { name, arguments: args } = body;
  try {
    const result = await executeTool(
      name,
      args || {},
      buildRequestContext(req, { transport: "rest-tools-call" })
    );
    sendToolResponse(req, res, result);
  } catch (error) {
    sendExecutionError(res, error);
  }
});

app.get("/rpc/tools", authMiddleware, (req, res) => {
  const accept = req.headers.accept || "application/json";
  const allTools = Object.values(tools).flat();

  if (accept.includes("application/yaml") || accept.includes("text/yaml")) {
    const yaml = require("js-yaml");
    res.type("yaml").send(yaml.dump({ tools: allTools }));
  } else {
    res.json({ tools: allTools });
  }
});

// Static file server for uploads/downloads
const serveIndex = require("serve-index");
const FILES_DIR = path.join(os.homedir(), "cicy-files");
if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

// Serve files with directory listing (auth required)
app.use("/files", authMiddleware, require("express").static(FILES_DIR));
app.use("/files", authMiddleware, serveIndex(FILES_DIR, { icons: true, view: "details" }));

// Dynamic tool endpoints: /rpc/{tool_name}
Object.values(tools)
  .flat()
  .forEach((tool) => {
    app.post(`/rpc/${tool.name}`, authMiddleware, async (req, res) => {
      let body = req.body;

      if (req.get("Content-Type")?.includes("application/yaml")) {
        try {
          body = await parseYamlBody(req);
        } catch (error) {
          return res.status(400).json({ error: `Invalid YAML: ${error.message}` });
        }
      }

      try {
        const result = await executeTool(
          tool.name,
          body || {},
          buildRequestContext(req, { transport: "rest-tool-endpoint", toolName: tool.name })
        );
        sendToolResponse(req, res, result);
      } catch (error) {
        sendExecutionError(res, error);
      }
    });
  });

// File upload to path: curl --data-binary @local.js http://localhost:8101/rpc/upload/C:/Users/Administrator/data/file.js
app.post(
  "/rpc/upload/*",
  authMiddleware,
  require("express").raw({ type: "*/*", limit: "10mb" }),
  (req, res) => {
    try {
      const filePath = req.params[0];
      if (!filePath) return res.status(400).json({ error: "Missing path" });
      const dir = require("path").dirname(filePath);
      if (!require("fs").existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
      require("fs").writeFileSync(filePath, req.body);
      const size = require("fs").statSync(filePath).size;
      res.json({ success: true, path: filePath, size });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// File upload + execute: curl -X POST --data-binary @local.js http://localhost:8101/rpc/exec/node
// Supported types: shell, python, node, js (js = browser exec_js)
app.post(
  "/rpc/exec/:type",
  authMiddleware,
  require("express").text({ type: "*/*", limit: "10mb" }),
  async (req, res) => {
    const type = req.params.type;
    const body = typeof req.body === "string" ? req.body : req.body.toString("utf-8");
    if (!body) return res.status(400).json({ error: "Empty body" });

    const TMP = require("path").join(require("os").homedir(), "tmp");
    if (!require("fs").existsSync(TMP)) require("fs").mkdirSync(TMP, { recursive: true });

    try {
      const toolName = type === "js" ? "exec_js_file" : `exec_${type}_file`;
      const result = await executeTool(
        toolName,
        { content: body, win_id: parseInt(req.query.win_id) || 1 },
        buildRequestContext(req, {
          transport: "rest-exec",
          toolName,
        })
      );
      res.json({ result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Start server
const server = http.createServer(app);

// 必须在 whenReady 之前设置调试端口
electronApp.commandLine.appendSwitch("remote-debugging-port", "9221");
log.info("[MCP] Remote debugging enabled on port 9221");

// IPC Bridge: expose all RPC tools to renderer via ipcMain.handle
const { ipcMain } = require("electron");
ipcMain.handle("rpc", async (event, toolName, args) => {
  console.log("[IPC Bridge] called:", toolName, JSON.stringify(args));
  try {
    const result = await executeTool(toolName, args || {}, {
      transport: "ipc",
      toolName,
      controlSessionId: args?.controlSessionId || null,
      agentId: args?.agentId || null,
      runtimeSessionId: args?.runtimeSessionId || null,
      windowRef: args?.windowRef || null,
      accountIdx: args?.accountIdx,
      worker: getWorkerIdentity(),
      webContentsId: event.sender.id,
    });
    console.log("[IPC Bridge] success:", toolName);
    return result;
  } catch (e) {
    console.error("[IPC Bridge] error:", toolName, e.message);
    throw e;
  }
});
console.log("[IPC Bridge] All RPC tools available via ipcRenderer.invoke('rpc', toolName, args)");

const workerClient = maybeCreateWorkerClient(authManager);

const PROJECT_ROOT = path.join(__dirname, "..");
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const MAC_LAUNCHER_SOURCE = path.join(PROJECT_ROOT, "cicy-dektop.command");
const MAC_LAUNCHER_TARGET = path.join(DESKTOP_DIR, "cicy-dektop.command");
const WINDOWS_LAUNCHER_TARGET = path.join(DESKTOP_DIR, "cicy-desktop.cmd");

function ensureDesktopLauncher() {
  try {
    if (process.platform === "darwin") {
      ensureMacDesktopLauncher();
      return;
    }

    if (process.platform === "win32") {
      ensureWindowsDesktopLauncher();
    }
  } catch (error) {
    log.warn(`[Launcher] Failed to ensure desktop launcher: ${error.message}`);
  }
}

function ensureMacDesktopLauncher() {
  if (fs.existsSync(MAC_LAUNCHER_TARGET) || !fs.existsSync(MAC_LAUNCHER_SOURCE)) {
    return;
  }

  fs.copyFileSync(MAC_LAUNCHER_SOURCE, MAC_LAUNCHER_TARGET);
  fs.chmodSync(MAC_LAUNCHER_TARGET, 0o755);
  log.info(`[Launcher] Created desktop launcher at ${MAC_LAUNCHER_TARGET}`);
}

function ensureWindowsDesktopLauncher() {
  if (fs.existsSync(WINDOWS_LAUNCHER_TARGET)) {
    return;
  }

  const launcherContent = [
    "@echo off",
    "setlocal",
    `cd /d \"${PROJECT_ROOT}\"`,
    'if not exist package.json (',
    '  echo [ERROR] package.json not found in project directory',
    '  pause',
    '  exit /b 1',
    ')',
    'echo =========================================',
    'echo   CiCy Desktop Master + Worker',
    'echo   Project: %CD%',
    'echo =========================================',
    'npm start',
    'if errorlevel 1 (',
    '  echo.',
    '  echo [ERROR] Startup failed',
    '  pause',
    ')',
  ].join("\r\n");

  fs.writeFileSync(WINDOWS_LAUNCHER_TARGET, `${launcherContent}\r\n`, "utf8");
  log.info(`[Launcher] Created desktop launcher at ${WINDOWS_LAUNCHER_TARGET}`);
}

electronApp.whenReady().then(() => {
  ensureDesktopLauncher();
  // 为 webview partition 设置代理
  if (config.proxy) {
    const { session } = require("electron");
    const mainSession = session.fromPartition("persist:main");
    mainSession
      .setProxy({
        proxyRules: config.proxy,
      })
      .then(() => {
        log.info(`[Proxy] persist:main partition 已设置代理: ${config.proxy}`);
      })
      .catch((err) => {
        log.error("[Proxy] persist:main partition 设置代理失败:", err);
      });
  }
  server.listen(PORT, async () => {
    log.info(`[MCP] Log file: ${config.logFilePath}`);
    log.info(`[MCP] Server listening on http://localhost:${PORT}`);
    log.info(`[MCP] SSE endpoint: http://localhost:${PORT}/mcp`);
    log.info(`[MCP] REST API docs: http://localhost:${PORT}/docs`);
    log.info(`[MCP] Remote debugger: http://localhost:9221`);
    if (START_URL) {
      createWindow({ url: START_URL }, ACCOUNT);
    }
    if (workerClient) {
      try {
        await workerClient.start();
        log.info(`[Cluster] Worker registered to ${process.env.CICY_MASTER_URL}`);
      } catch (error) {
        log.error(`[Cluster] Worker registration failed: ${error.message}`);
      }
    }
  }).on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(`[MCP] Port ${PORT} is already in use`);
    } else {
      log.error("[MCP] Server error:", err);
    }
    electronApp.quit();
  });
});

electronApp.on("window-all-closed", () => {
  // Keep app running
});

function cleanup() {
  log.info("[MCP] Server shutting down");
  if (workerClient) {
    workerClient.stop();
  }
  server.close();
  electronApp.quit();
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// 为所有 session（包括 webview partition）设置代理
electronApp.on("session-created", (session) => {
  if (config.proxy) {
    session
      .setProxy({
        proxyRules: config.proxy,
      })
      .then(() => {
        log.info(`[Proxy] Session ${session.partition || "default"} 已设置代理: ${config.proxy}`);
      })
      .catch((err) => {
        log.error(`[Proxy] Session ${session.partition || "default"} 设置代理失败:`, err);
      });
  }
});
