const express = require("express");
const cors = require("cors");
const path = require("path");
const uiRoutes = require("./ui-routes");

function createExpressApp(authMiddleware, tools = {}) {
  const app = express();

  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  app.use(express.json());
  app.use(express.text());

  // Health check - no auth
  app.get("/ping", (req, res) => {
    res.json({ ping: "pong", ts: Date.now() });
  });

  // Swagger UI
  app.get("/docs", (req, res) => {
    const htmlPath = path.join(__dirname, "../swagger-ui.html");
    res.sendFile(htmlPath);
  });

  // OpenAPI spec - dynamic generation, no auth
  app.get("/openapi.json", (req, res) => {
    const acceptHeader = req.get("Accept") || "application/json";
    const useYaml = acceptHeader.includes("application/yaml");

    const allTools = Object.entries(tools).flatMap(([tag, toolList]) =>
      toolList.map((tool) => ({ ...tool, tag }))
    );

    const openapi = {
      openapi: "3.0.0",
      info: {
        title: "Electron MCP REST API",
        version: "1.0.0",
        description: `REST API for Electron MCP tools - ${allTools.length} tools available`,
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

    // Generate endpoint for each tool
    allTools.forEach((tool) => {
      openapi.paths[`/rpc/${tool.name}`] = {
        post: {
          summary: tool.name,
          description: tool.description,
          tags: [tool.tag],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/yaml": {
                schema: tool.inputSchema,
              },
              "application/json": {
                schema: tool.inputSchema,
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

    if (useYaml) {
      const yaml = require("js-yaml");
      res.type("application/yaml").send(yaml.dump(openapi));
    } else {
      res.json(openapi);
    }
  });

  // Serve UI page (no auth — page handles token itself)
  app.get("/ui", (req, res) => {
    res.sendFile(path.join(__dirname, "../ui.html"));
  });

  // Mount UI API routes
  app.use("/ui", uiRoutes);

  return app;
}

module.exports = { createExpressApp };
