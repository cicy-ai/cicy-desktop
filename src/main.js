const { app: electronApp } = require("electron");
const { default: contextMenu } = require("electron-context-menu");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cicyCodeSidecar = require("./sidecar/cicy-code");
const backendsIPC = require("./backends/ipc");
const { openHomepage } = require("./backends/homepage-window");
const backendsRegistry = require("./backends/registry");
const { openWindowForBackend } = require("./backends/window-manager");
const { Menu } = require("electron");
const { setupAppIcons } = require("./tray");
const appUpdater = require("./app-updater");

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
const { createChromeProxyRoutes } = require("./server/chrome-proxy-routes");
const { createChromeManagementRoutes } = require("./server/chrome-management-routes");
const { createMcpServer, setupMcpRoutes } = require("./server/mcp-server");
const { registerTool } = require("./server/tool-registry");
const { loadToolCatalog } = require("./server/tool-catalog");
const { executeTool } = require("./server/tool-executor");
const { getWorkerIdentity } = require("./cluster/worker-identity");
const { listLocalAgents } = require("./cluster/local-agent-registry");
const { listArtifacts } = require("./cluster/artifact-registry");
const { WorkerClient } = require("./cluster/worker-client");
const { getChromeRuntimeRegistry } = require("./chrome/runtime-registry");

// Setup
// setupElectronFlags(); // Already done above
setupErrorHandlers();

// i18n: initialize as early as possible so menus / tray / dialogs use the
// detected locale. app.getLocale() works after Electron is ready, but for the
// initial label fallback we use process.env.LANG so the first burst of
// console output / tray template still falls back to English when locale
// detection fails.
const i18n = require("./i18n");
const __initialLocale = (() => {
  try { return electronApp.getLocale ? electronApp.getLocale() : (process.env.LANG || ""); }
  catch { return process.env.LANG || ""; }
})();
i18n.init(__initialLocale);

// Single-instance lock: only one cicy-desktop process can hold the primary
// instance. A second launch sends `second-instance` with argv to the primary
// and exits itself. The primary focuses its homepage so the user sees the
// running app instead of nothing happening.
const __singleLock = electronApp.requestSingleInstanceLock();
if (!__singleLock) {
  electronApp.exit(0);
}
electronApp.on("second-instance", () => {
  try {
    const { openHomepage } = require("./backends/homepage-window");
    openHomepage();
  } catch {}
  const { BrowserWindow } = require("electron");
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
});

// Parse arguments
const {
  PORT,
  START_URL,
  PROXY,
  oneWindow,
  ACCOUNT,
  chromeBinary,
  chromeUserDataRoot,
  chromeDebuggerBasePort,
} = parseArgs();
config.port = PORT;
if (chromeBinary) {
  config.chromeBinary = chromeBinary;
}
if (chromeUserDataRoot) {
  config.chromeUserDataRoot = chromeUserDataRoot;
}
if (chromeDebuggerBasePort) {
  config.chromeDebuggerBasePort = chromeDebuggerBasePort;
}
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
  const chromeRuntimeRegistry = getChromeRuntimeRegistry();
  return {
    baseUrl: `http://127.0.0.1:${config.port}`,
    authToken: authManager.getToken(),
    capabilities: Object.values(tools)
      .flat()
      .map((tool) => tool.name),
    agents: listLocalAgents(),
    chromeProfiles: chromeRuntimeRegistry.list(),
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

// Chrome profile debugger HTTP facade (no websocket proxy in v1)
app.use(
  "/chrome",
  authMiddleware,
  createChromeProxyRoutes({
    registry: getChromeRuntimeRegistry(),
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

app.use(
  "/api/chrome",
  createChromeManagementRoutes({
    authMiddleware,
    executeTool,
    buildRequestContext,
  })
);

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
  setupAppIcons();
  ensureDesktopLauncher();
  // Start bundled cicy-code daemon as a sidecar. Reuses an existing
  // instance on :8008 if one is already running; no-op on Windows.
  cicyCodeSidecar
    .start({ logPath: path.join(os.homedir(), "logs", "cicy-code-sidecar.log") })
    .then((c) => { if (c) log.info(`[Sidecar] cicy-code spawned pid=${c.pid}`); })
    .catch((e) => log.warn(`[Sidecar] cicy-code start failed: ${e.message}`));

  // Backend launcher: app menu + IPC handlers. Menu adds a Backends top-level
  // entry; IPC powers the launcher window (src/backends/launcher.html).
  backendsIPC.register({ sidecarLogPath: path.join(os.homedir(), "logs", "cicy-code-sidecar.log") });
  require("./backends/sidecar-ipc").register({ sidecarLogPath: path.join(os.homedir(), "logs", "cicy-code-sidecar.log") });
  const menuTemplate = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: i18n.t("menu.backends"),
      submenu: [
        { label: i18n.t("menu.showHomepage"), accelerator: "CmdOrCtrl+Shift+H", click: () => openHomepage() },
        { type: "separator" },
        {
          label: i18n.t("menu.newLocalWindow"),
          accelerator: "CmdOrCtrl+N",
          click: async () => {
            const local = backendsRegistry.get(backendsRegistry.LOCAL_ID);
            if (local) await openWindowForBackend(local, { sidecarLogPath: path.join(os.homedir(), "logs", "cicy-code-sidecar.log") });
          },
        },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // No START_URL (typical .app double-click): land on the homepage. With
  // START_URL set (bin/cicy-desktop --url …) the existing createWindow path
  // below still fires, preserving the legacy power-user entry point.
  if (!START_URL) {
    openHomepage();
  }
  // Start background update checks (Windows: silent download+install on quit;
  // macOS: unsigned — will error silently and fall back to manual download).
  const hw = require("./backends/homepage-window");
  appUpdater.init(hw.getHomepageWindow && hw.getHomepageWindow());

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
  log.info("[Cleanup] shutting down child services");
  try { cicyCodeSidecar.stop(); } catch (e) { /* best-effort */ }

  // Kill cicy-code, all tmux servers, gotty/ttyd, and code-server processes
  // that the cicy-code sidecar may have spawned. best-effort, sync, cross-platform.
  try {
    const { execSync } = require("child_process");
    const targets = ["cicy-code", "ttyd", "gotty", "code-server"];

    if (process.platform === "win32") {
      // Windows: taskkill /F /IM <name>.exe (and base name in case extension differs)
      for (const t of targets) {
        try { execSync(`taskkill /F /IM ${t}.exe`, { stdio: "ignore", windowsHide: true }); } catch {}
        try { execSync(`taskkill /F /IM ${t}`, { stdio: "ignore", windowsHide: true }); } catch {}
      }
      // Windows has no tmux by default; nothing to do.
    } else {
      // macOS / Linux: pkill matches by command line.
      for (const t of targets) {
        try { execSync(`pkill -f ${t}`, { stdio: "ignore" }); } catch {}
      }
      try { execSync(`tmux kill-server`, { stdio: "ignore" }); } catch {}
    }
  } catch (e) {
    log.warn(`[Cleanup] kill children failed: ${e.message}`);
  }

  if (workerClient) {
    workerClient.stop();
  }
  try { server.close(); } catch {}
}

let __isCleaningUp = false;
electronApp.on("before-quit", () => {
  electronApp.isQuitting = true;
  if (__isCleaningUp) return;
  __isCleaningUp = true;
  cleanup();
});

process.on("SIGTERM", () => { electronApp.isQuitting = true; cleanup(); electronApp.quit(); });
process.on("SIGINT",  () => { electronApp.isQuitting = true; cleanup(); electronApp.quit(); });

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
