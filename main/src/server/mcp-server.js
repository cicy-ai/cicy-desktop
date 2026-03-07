const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const log = require("electron-log");

const transports = new Map();

function createMcpServer() {
  return new McpServer({
    name: "electron-mcp",
    version: "1.0.0",
  });
}

function createTransport(res, sessionId) {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(sessionId, transport);

  res.on("close", () => {
    transports.delete(sessionId);
    log.debug(`[MCP] SSE connection closed: ${sessionId}`);
  });

  return transport;
}

function setupMcpRoutes(app, mcpServer, authMiddleware) {
  app.get("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.query.sessionId || req.headers["x-session-id"];
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }

    log.debug(`[MCP] SSE connection established: ${sessionId}`);
    const transport = createTransport(res, sessionId);
    await mcpServer.connect(transport);
  });

  app.post("/messages", authMiddleware, async (req, res) => {
    const sessionId = req.body.sessionId || req.headers["x-session-id"];
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }

    const transport = transports.get(sessionId);
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.status(400).json({ error: `No active SSE connection for session: ${sessionId}` });
    }
  });
}

module.exports = { createMcpServer, setupMcpRoutes };
