const { app: electronApp, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const express = require("express");
const cors = require("cors");
const http = require("http");
const swaggerUi = require("swagger-ui-express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");
const { config } = require("./config");
const { createWindow } = require("./utils/window-utils");
const { AuthManager } = require("./utils/auth");

if (process.platform === "linux") {
  // electronApp.disableHardwareAcceleration(); // 这一行比命令行开关更彻底
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
  electronApp.commandLine.appendSwitch("log-level", "3");
  // electronApp.commandLine.appendSwitch("no-sandbox");

  electronApp.commandLine.appendSwitch("disable-notifications");
  electronApp.commandLine.appendSwitch("disable-geolocation");

  electronApp.commandLine.appendSwitch("disable-dev-shm-usage");
  electronApp.commandLine.appendSwitch("disable-setuid-sandbox");

  // --- 新增下面这几行以修复 :2 白屏问题 ---
  electronApp.commandLine.appendSwitch("disable-gpu");
  electronApp.commandLine.appendSwitch("disable-software-rasterizer");
  electronApp.commandLine.appendSwitch("disable-gpu-compositing");
  electronApp.commandLine.appendSwitch("disable-gpu-rasterization");
  // 强制使用 SwiftShader 或逻辑渲染器
  electronApp.commandLine.appendSwitch("use-gl", "swiftshader");
}

// 捕获未处理的异常，防止弹窗
process.on("uncaughtException", (error) => {
  log.error("[Uncaught Exception]", error);
  console.error("[Uncaught Exception]", error);
});

process.on("unhandledRejection", (reason, promise) => {
  log.error("[Unhandled Rejection]", reason);
  console.error("[Unhandled Rejection]", reason);
});

const transports = new Map();

const args = process.argv.slice(2);
let PORT = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
if (!PORT) {
  const portIndex = args.indexOf("--port");
  if (portIndex !== -1 && args[portIndex + 1]) {
    PORT = args[portIndex + 1];
  }
}
if (!PORT) {
  PORT = process.env.PORT;
}
PORT = parseInt(PORT) || 8101;
config.port = PORT;

let START_URL = args.find((arg) => arg.startsWith("--url="))?.split("=")[1];
if (!START_URL) {
  const urlIndex = args.indexOf("--url");
  if (urlIndex !== -1 && args[urlIndex + 1]) {
    START_URL = args[urlIndex + 1];
  }
}

// Check for --one-window argument
if (args.includes("--one-window")) {
  config.oneWindow = true;
  log.info("[MCP] Single window mode enabled via --one-window");
}

const logsDir = path.join(electronApp.getPath("home"), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
config.logsDir = logsDir;
config.logFilePath = path.join(logsDir, `electron-mcp-${config.port}.log`);

log.transports.file.resolvePathFn = () => config.logFilePath;

// 配置日志格式
log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";
log.transports.console.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";

// 包装 log 方法以添加调用位置信息
const originalInfo = log.info.bind(log);
const originalError = log.error.bind(log);
const originalWarn = log.warn.bind(log);
const originalDebug = log.debug.bind(log);

const getCallerInfo = () => {
  const stack = new Error().stack;
  const stackLines = stack.split("\n");
  for (let i = 3; i < stackLines.length; i++) {
    const line = stackLines[i];
    if (line.includes("/src/") || line.includes("/tools/")) {
      // 匹配格式: "at functionName (path:line:col)" 或 "at path:line:col"
      const matchWithFunc = line.match(/at\s+(\S+)\s+\((.+):(\d+):\d+\)/);
      const matchNoFunc = line.match(/at\s+(.+):(\d+):\d+/);

      if (matchWithFunc) {
        const funcName = matchWithFunc[1];
        const fullPath = matchWithFunc[2];
        const fileName = fullPath.split("/").pop();
        const lineNumber = matchWithFunc[3];
        return `(${fileName}:${funcName}:${lineNumber})`;
      } else if (matchNoFunc) {
        const fullPath = matchNoFunc[1];
        const fileName = fullPath.split("/").pop();
        const lineNumber = matchNoFunc[2];
        return `(${fileName}:${lineNumber})`;
      }
    }
  }
  return "";
};

log.info = (...args) => originalInfo(...args, getCallerInfo());
log.error = (...args) => originalError(...args, getCallerInfo());
log.warn = (...args) => originalWarn(...args, getCallerInfo());
log.debug = (...args) => originalDebug(...args, getCallerInfo());

log.info(`[MCP] Server starting at ${new Date().toISOString()}`);

// 初始化认证管理器
const authManager = new AuthManager();

// 将 Zod schema 转换为 JSON Schema
function zodToJsonSchema(zodSchema) {
  if (!zodSchema || !zodSchema._def) {
    return { type: "object" };
  }

  const def = zodSchema._def;

  if (def.typeName === "ZodObject") {
    const properties = {};
    const required = [];

    const shape = def.shape();
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      // 检查是否是 optional 或 default
      const isOptional =
        value._def.typeName === "ZodOptional" || value._def.typeName === "ZodDefault";
      if (!isOptional) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 && { required }),
    };
  }

  if (def.typeName === "ZodString") {
    return { type: "string" };
  }

  if (def.typeName === "ZodNumber") {
    return { type: "number" };
  }

  if (def.typeName === "ZodBoolean") {
    return { type: "boolean" };
  }

  if (def.typeName === "ZodArray") {
    return {
      type: "array",
      items: zodToJsonSchema(def.type),
    };
  }

  if (def.typeName === "ZodOptional") {
    return zodToJsonSchema(def.innerType);
  }

  if (def.typeName === "ZodDefault") {
    const schema = zodToJsonSchema(def.innerType);
    schema.default = def.defaultValue();
    return schema;
  }

  if (def.typeName === "ZodEnum") {
    return {
      type: "string",
      enum: def.values,
    };
  }

  return { type: "object" };
}

const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "50mb" }));

// Ping endpoint - 无需认证
app.get("/ping", (req, res) => {
  res.json({ ping: "pong", ts: Date.now() });
});

// OpenAPI spec - 无需认证，动态生成，默认 YAML
app.get("/openapi.json", (req, res) => {
  const acceptHeader = req.get("Accept") || "application/yaml";
  const useJson =
    acceptHeader.includes("application/json") && !acceptHeader.includes("application/yaml");

  const tools = Array.from(toolHandlers.keys()).map((name) => ({
    name: name,
    description: toolDescriptions.get(name) || "",
    schema: zodToJsonSchema(toolSchemas.get(name)),
    tag: toolTags.get(name) || "Tools",
  }));

  const openapi = {
    openapi: "3.0.0",
    info: {
      title: "Electron MCP REST API",
      version: "1.0.0",
      description: `REST API for Electron MCP tools - ${tools.length} tools available`,
    },
    servers: [
      {
        url: "https://g-electron.cicy.de5.net",
        description: "Remote server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "token",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/rpc/tools": {
        get: {
          summary: "List all available tools",
          tags: ["Tools"],
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "List of tools",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      tools: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            description: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  // 为每个工具生成端点
  tools.forEach((tool) => {
    openapi.paths[`/rpc/${tool.name}`] = {
      post: {
        description: tool.description,
        tags: [tool.tag],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.schema,
            },
            "application/yaml": {
              schema: tool.schema,
            },
          },
        },
        responses: {
          200: {
            description: "Tool execution result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          type: { type: "string" },
                          text: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
              "application/yaml": {
                schema: {
                  type: "string",
                },
              },
            },
          },
          404: { description: "Tool not found" },
          500: { description: "Execution error" },
        },
      },
    };
  });

  if (useJson) {
    res.json(openapi);
  } else {
    const yaml = require("js-yaml");
    res.type("application/yaml").send(yaml.dump(openapi));
  }
});

// 认证中间件
function authMiddleware(req, res, next) {
  if (!authManager.validateAuth(req)) {
    log.warn("[MCP] Unauthorized access attempt:", req.url);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const mcpServer = new McpServer({
  name: "electron-mcp",
  version: "1.0.0",
  description: "Electron MCP Server with browser automation tools",
});

// 保存工具处理函数
const toolHandlers = new Map();
const toolDescriptions = new Map();
const toolSchemas = new Map();
const toolTags = new Map();

function registerTool(title, description, schema, handler, options = {}) {
  const { tag = "Tools" } = options;

  // 确保 schema 是有效的 Zod 对象
  if (!schema || typeof schema !== "object" || !schema._def) {
    log.warn(`Tool "${title}" has invalid schema, using empty object`);
    log.warn(`  Schema type: ${typeof schema}, has _def: ${schema && schema._def ? "yes" : "no"}`);
    schema = z.object({});
  }

  // 保存处理函数、描述、schema 和 tag
  toolHandlers.set(title, handler);
  toolDescriptions.set(title, description);
  toolSchemas.set(title, schema);
  toolTags.set(title, tag);

  mcpServer.registerTool(
    title,
    {
      title,
      description,
      inputSchema: schema,
    },
    async (s) => {
      try {
        return handler(s);
      } catch (e) {
        log.error("Error", title, e);
        return {
          content: [{ type: "text", text: `${title} invoke error:${e},tool desc: ${description}` }],
          isError: true,
        };
      }
    }
  );
  //log.debug(`Registered tool: ${title}`);
}

require("./tools/ping")(registerTool);
require("./tools/window-tools")(registerTool);
require("./tools/cdp-tools")(registerTool);
require("./tools/exec-js")(registerTool);

function createTransport(res) {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  const originalSend = transport.send.bind(transport);
  transport.send = async (message) => {
    return originalSend(message);
  };

  return transport;
}

app.get("/mcp", authMiddleware, async (req, res) => {
  try {
    const transport = createTransport(res);
    const mcpServer = createMcpServer(); // 为每个连接创建新的 server 实例

    res.on("close", () => {
      delete transports[transport.sessionId];
    });

    // 包装 transport 的 send 方法来捕获错误
    const originalSend = transport.send.bind(transport);
    transport.send = async (message) => {
      try {
        return await originalSend(message);
      } catch (error) {
        log.error("[MCP] Error sending message:", error);
        log.error("[MCP] Message:", JSON.stringify(message, null, 2));
        throw error;
      }
    };

    await mcpServer.connect(transport);
    log.info("[MCP] SSE connection established:", transport.sessionId, req.url);
  } catch (error) {
    log.error("[MCP] SSE error:", error);
    log.error("[MCP] SSE error stack:", error.stack);
    res.status(500).end();
  }
});

app.post("/messages", authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (!transport) {
    res.status(400).send("No transport found for sessionId");
    return;
  }

  try {
    log.debug(`[MCP] Handling message: ${req.body.method}`);
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    log.error("[MCP] Error handling message:", error);
    log.error("[MCP] Error stack:", error.stack);
    res.status(500).json({ error: error.message });
  }
});

// RPC endpoint - 直接调用工具，不需要 SSE
app.post("/rpc", authMiddleware, express.json(), async (req, res) => {
  try {
    const { method, params } = req.body;
    const acceptHeader = req.get("Accept") || "application/json";
    const useYaml = acceptHeader.includes("application/yaml");

    if (method === "tools/call") {
      const { name, arguments: args } = params;

      // 从 Map 中获取处理函数
      const handler = toolHandlers.get(name);
      if (!handler) {
        const errorResponse = {
          jsonrpc: "2.0",
          id: req.body.id || 1,
          error: { message: `Tool not found: ${name}` },
        };

        if (useYaml) {
          const yaml = require("js-yaml");
          res.type("application/yaml").send(yaml.dump(errorResponse));
        } else {
          res.status(404).json(errorResponse);
        }
        return;
      }

      // 直接调用处理函数
      const result = await handler(args);

      const response = {
        jsonrpc: "2.0",
        id: req.body.id || 1,
        result: result,
      };

      if (useYaml) {
        const yaml = require("js-yaml");
        res.type("application/yaml").send(yaml.dump(response));
      } else {
        res.json(response);
      }
    } else {
      res.status(400).json({ error: "Unsupported method" });
    }
  } catch (error) {
    log.error("[RPC] Error:", error);
    const errorResponse = {
      jsonrpc: "2.0",
      id: req.body.id || 1,
      error: { message: error.message },
    };

    const acceptHeader = req.get("Accept") || "application/json";
    if (acceptHeader.includes("application/yaml")) {
      const yaml = require("js-yaml");
      res.type("application/yaml").send(yaml.dump(errorResponse));
    } else {
      res.status(500).json(errorResponse);
    }
  }
});

// RPC tools list - 返回所有可用工具
app.get("/rpc/tools", authMiddleware, (req, res) => {
  const acceptHeader = req.get("Accept") || "application/yaml";
  const useJson =
    acceptHeader.includes("application/json") && !acceptHeader.includes("application/yaml");

  const tools = Array.from(toolHandlers.keys()).map((name) => ({
    name: name,
    description: toolDescriptions.get(name) || "",
  }));

  const result = { tools };

  if (useJson) {
    res.json(result);
  } else {
    const yaml = require("js-yaml");
    res.type("application/yaml").send(yaml.dump(result));
  }
});

// RPC tools schemas - 返回所有工具的 schema（用于生成 OpenAPI）
app.get("/rpc/schemas", authMiddleware, (req, res) => {
  const schemas = {};

  // 从保存的 toolSchemas 转换
  for (const [name, zodSchema] of toolSchemas) {
    try {
      schemas[name] = zodToJsonSchema(zodSchema);
    } catch (e) {
      log.error(`Error converting schema for ${name}:`, e);
      schemas[name] = { type: "object" };
    }
  }

  res.json({ schemas });
});

// REST API - 为每个工具创建独立端点
app.post("/rpc/:toolName", authMiddleware, express.json(), async (req, res) => {
  try {
    const { toolName } = req.params;
    const args = req.body;
    const acceptHeader = req.get("Accept") || "application/yaml";
    const useJson =
      acceptHeader.includes("application/json") && !acceptHeader.includes("application/yaml");

    const handler = toolHandlers.get(toolName);
    if (!handler) {
      const errorResponse = {
        error: `Tool not found: ${toolName}`,
        available: Array.from(toolHandlers.keys()),
      };

      if (useJson) {
        return res.status(404).json(errorResponse);
      } else {
        const yaml = require("js-yaml");
        return res.status(404).type("application/yaml").send(yaml.dump(errorResponse));
      }
    }

    const result = await handler(args);

    if (useJson) {
      res.json(result);
    } else {
      const yaml = require("js-yaml");
      res.type("application/yaml").send(yaml.dump(result));
    }
  } catch (error) {
    log.error(`[REST] Error calling ${req.params.toolName}:`, error);
    const acceptHeader = req.get("Accept") || "application/yaml";
    const useJson =
      acceptHeader.includes("application/json") && !acceptHeader.includes("application/yaml");

    if (useJson) {
      res.status(500).json({ error: error.message });
    } else {
      const yaml = require("js-yaml");
      res
        .status(500)
        .type("application/yaml")
        .send(yaml.dump({ error: error.message }));
    }
  }
});

// Python execution endpoint
app.post("/rpc/python", authMiddleware, express.json(), async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: "code is required" });
    }

    const { exec } = require("child_process");
    const pythonPath = path.join(__dirname, "..", "python-exec.py");

    exec(`python3 ${pythonPath} '${code.replace(/'/g, "'\\''")}'`, (error, stdout, stderr) => {
      if (error) {
        return res.json({
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: false, error: stderr || error.message }),
            },
          ],
        });
      }

      try {
        const result = JSON.parse(stdout);
        res.json({
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (e) {
        res.json({
          content: [{ type: "text", text: stdout }],
        });
      }
    });
  } catch (error) {
    log.error("[Python] Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Enable remote debugging
const REMOTE_DEBUGGING_PORT =
  args.find((arg) => arg.startsWith("--remote-debugging-port="))?.split("=")[1] ||
  (args.indexOf("--remote-debugging-port") !== -1
    ? args[args.indexOf("--remote-debugging-port") + 1]
    : null) ||
  process.env.REMOTE_DEBUGGING_PORT ||
  "9222";

electronApp.commandLine.appendSwitch("remote-debugging-port", REMOTE_DEBUGGING_PORT);
log.info(`[MCP] Remote debugging enabled on port ${REMOTE_DEBUGGING_PORT}`);

electronApp.whenReady().then(() => {
  log.info(`[MCP] Log file: ${config.logFilePath}`);
  log.info(`[MCP] Server listening on http://localhost:${PORT}`);
  log.info(`[MCP] SSE endpoint: http://localhost:${PORT}/mcp`);
  log.info(`[MCP] REST API docs: http://localhost:${PORT}/docs`);
  log.info(`[MCP] Remote debugger: http://localhost:${REMOTE_DEBUGGING_PORT}`);

  // 动态生成 Swagger spec
  const tools = Array.from(toolHandlers.keys()).map((name) => ({
    name: name,
    description: toolDescriptions.get(name) || "",
  }));

  // 为每个工具生成 path
  const paths = {
    "/rpc/tools": {
      get: {
        summary: "List all available tools",
        tags: ["Tools"],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "List of tools",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tools: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  // 为每个工具生成端点
  tools.forEach((tool) => {
    paths[`/rpc/${tool.name}`] = {
      post: {
        summary: tool.description || `Call ${tool.name}`,
        description: tool.description,
        tags: ["Tools"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
        responses: {
          200: {
            description: "Tool execution result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    content: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          type: { type: "string" },
                          text: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          404: { description: "Tool not found" },
          500: { description: "Execution error" },
        },
      },
    };
  });

  const swaggerSpec = {
    openapi: "3.0.0",
    info: {
      title: "Electron MCP REST API",
      version: "1.0.0",
      description: `REST API for Electron MCP tools - ${tools.length} tools available`,
    },
    servers: [
      {
        url: "https://g-electron.cicy.de5.net",
        description: "Remote server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "token",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: paths,
  };

  // Swagger UI - 使用自定义 HTML
  app.get("/docs", (req, res) => {
    res.sendFile(__dirname + "/swagger-ui.html");
  });

  if (START_URL) {
    log.info(`[MCP] Opening window with URL: ${START_URL}`);
    createWindow({ url: START_URL });
  }

  server.listen(PORT).on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(`[MCP] Port ${PORT} is already in use`);
    } else {
      log.error("[MCP] Server error:", err);
    }
    electronApp.quit();
  });
});

electronApp.on("window-all-closed", () => {
  if (!START_URL) {
    electronApp.quit();
  }
});

function cleanup() {
  log.info("[MCP] Shutting down...");
  server.close(() => {
    log.info("[MCP] HTTP server closed");
    electronApp.quit();
  });
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
