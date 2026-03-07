const { app: electronApp } = require("electron");

// Setup Electron flags IMMEDIATELY after require
if (process.platform === "linux") {
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
  // electronApp.commandLine.appendSwitch("disable-setuid-sandbox");
  electronApp.commandLine.appendSwitch("log-level", "3");
  electronApp.commandLine.appendSwitch("disable-notifications");
  electronApp.commandLine.appendSwitch("disable-geolocation");
  electronApp.commandLine.appendSwitch("disable-dev-shm-usage");
  electronApp.commandLine.appendSwitch("disable-gpu");
  electronApp.commandLine.appendSwitch("disable-software-rasterizer");
  electronApp.commandLine.appendSwitch("disable-gpu-compositing");
  electronApp.commandLine.appendSwitch("disable-gpu-rasterization");
  electronApp.commandLine.appendSwitch("use-gl", "swiftshader");
}

const http = require("http");
const log = require("electron-log");
const { z } = require("zod");
const { config } = require("./config");
const { createWindow } = require("./utils/window-utils");
const { AuthManager } = require("./utils/auth");
const { setupElectronFlags, setupErrorHandlers } = require("./server/electron-setup");
const { parseArgs } = require("./server/args-parser");
const { setupLogging, wrapLogger } = require("./server/logging");
const { createExpressApp } = require("./server/express-app");
const { createMcpServer, setupMcpRoutes } = require("./server/mcp-server");
const { registerTool } = require("./server/tool-registry");

// Setup
// setupElectronFlags(); // Already done above
setupErrorHandlers();

// Parse arguments
const { PORT, START_URL, oneWindow } = parseArgs();
config.port = PORT;
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
    res.setHeader("WWW-Authenticate", 'Basic realm="Electron MCP"');
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// Create servers
const mcpServer = createMcpServer();
const tools = {};
const app = createExpressApp(authMiddleware, tools);

// Register tools
const toolModules = require("./tools");

toolModules.forEach((module) => {
  module((title, description, schema, handler, options) => {
    registerTool(mcpServer, tools, title, description, schema, handler, options);
  });
});

// Setup MCP routes
setupMcpRoutes(app, mcpServer, authMiddleware);

// RPC endpoint with hot reload
app.post("/rpc/tools/call", authMiddleware, async (req, res) => {
  let body = req.body;

  // Parse YAML if Content-Type is application/yaml
  if (req.get("Content-Type")?.includes("application/yaml")) {
    try {
      const yaml = require("js-yaml");
      const rawBody = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });
      body = yaml.load(rawBody);
    } catch (error) {
      return res.status(400).json({ error: `Invalid YAML: ${error.message}` });
    }
  }

  const { name, arguments: args } = body;
  try {
    // Re-load tool modules
    const toolModules = require("./tools");

    let handler = null;
    let schema = null;

    toolModules.forEach((module) => {
      module((title, description, toolSchema, toolHandler, options) => {
        if (title === name) {
          handler = toolHandler;
          schema = toolSchema;
        }
      });
    });

    if (!handler) {
      throw new Error(`Tool '${name}' not found`);
    }

    const validatedArgs = schema.parse(args || {});
    const result = await handler(validatedArgs);

    // Support YAML response
    const accept = req.headers.accept || "application/json";
    if (accept.includes("application/yaml") || accept.includes("text/yaml")) {
      const yaml = require("js-yaml");
      res.type("yaml").send(yaml.dump({ result }));
    } else {
      res.json({ result });
    }
  } catch (error) {
    // Handle Zod validation errors
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
const fs = require("fs");
const path = require("path");
const serveIndex = require("serve-index");
const FILES_DIR = path.join(require("os").homedir(), "electron-mcp-files");
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

      // Parse YAML if Content-Type is application/yaml
      if (req.get("Content-Type")?.includes("application/yaml")) {
        try {
          const yaml = require("js-yaml");
          const rawBody = await new Promise((resolve) => {
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => resolve(data));
          });
          body = yaml.load(rawBody) || {};
        } catch (error) {
          return res.status(400).json({ error: `Invalid YAML: ${error.message}` });
        }
      }

      try {
        // Re-load tool modules
        const toolModules = require("./tools");

        let handler = null;
        let schema = null;

        toolModules.forEach((module) => {
          module((name, desc, inputSchema, fn) => {
            if (name === tool.name) {
              handler = fn;
              schema = inputSchema;
            }
          });
        });

        if (!handler) {
          throw new Error(`Tool '${tool.name}' not found`);
        }

        const validatedArgs = schema.parse(body || {});
        const result = await handler(validatedArgs);

        // Support YAML response
        const accept = req.headers.accept || "application/json";
        if (accept.includes("application/yaml") || accept.includes("text/yaml")) {
          const yaml = require("js-yaml");
          res.type("yaml").send(yaml.dump({ result }));
        } else {
          res.json({ result });
        }
      } catch (error) {
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
    });
  });

// Start server
const server = http.createServer(app);

// 必须在 whenReady 之前设置调试端口
electronApp.commandLine.appendSwitch("remote-debugging-port", "9221");
log.info("[MCP] Remote debugging enabled on port 9221");

electronApp.whenReady().then(() => {
  server.listen(PORT, () => {
    log.info(`[MCP] Log file: ${config.logFilePath}`);
    log.info(`[MCP] Server listening on http://localhost:${PORT}`);
    log.info(`[MCP] SSE endpoint: http://localhost:${PORT}/mcp`);
    log.info(`[MCP] REST API docs: http://localhost:${PORT}/docs`);
    log.info(`[MCP] Remote debugger: http://localhost:9221`);

    if (START_URL) {
      createWindow({ url: START_URL }, 0);
    }
  });
});

electronApp.on("window-all-closed", () => {
  // Keep app running
});

function cleanup() {
  log.info("[MCP] Server shutting down");
  server.close();
  electronApp.quit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
