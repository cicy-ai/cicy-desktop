# AGENTS.md

This file provides guidelines for AI agents working on this codebase.

## Build, Lint, and Test Commands

### Core Commands

```bash
# Start the MCP server (runs Electron app with MCP endpoint)
npm start

# Start with specific port
npm start -- --port=8102

# Start with URL and single window mode
npm start -- --url=http://example.com --one-window

# Run all tests (Jest with forceExit to handle Electron processes)
npm test

# Run a single test file
npm test -- api.ping.test.js

# Run tests matching a pattern
npm test -- --testNamePattern="ping"

# Format code with Prettier
npm run format

# Check formatting
npm run format:check

# Build distributables
npm run build
```

### Test Configuration

- Tests are in `tests/` directory with pattern `*.test.js`
- Jest runs with `--runInBand` (serial execution) due to Electron's single-process nature
- Tests use supertest for HTTP API testing
- Tests spawn actual Electron processes on dynamic ports
- Auth token loaded from `~/data/electron/token.txt`
- Test utilities in `tests/test-utils.js`

## Code Style Guidelines

### Language

- **CommonJS** only - use `require()` not ES modules
- Plain JavaScript - no TypeScript
- ES6+ features: async/await, arrow functions, template literals

### File Organization

```
src/
  main.js              # Main entry: Electron + Express + MCP server
  config.js            # Configuration constants
  tools/               # MCP tool implementations
    ping.js
    window-tools.js
    cdp-tools.js
    exec-js.js
  utils/               # Utility modules
    window-utils.js
    window-monitor.js
    cdp-utils.js
    snapshot-utils.js
    auth.js
tests/                 # Test files
  test-utils.js        # Shared test utilities
  *.test.js            # Individual test files
```

### Imports Order

```javascript
// 1. Built-in Node modules
const fs = require("fs");
const path = require("path");

// 2. External dependencies
const { BrowserWindow } = require("electron");
const { z } = require("zod");
const express = require("express");

// 3. Internal modules
const { config } = require("../config");
const { createWindow } = require("../utils/window-utils");
```

### Naming Conventions

- **Classes**: PascalCase (`AuthManager`, `BrowserWindow`)
- **Functions/variables**: camelCase (`getWindows`, `registerTool`)
- **Constants**: SCREAMING_SNAKE_CASE (`PORT`, `LOGS_DIR`)
- **Tool names**: snake_case (`open_window`, `get_windows`)
- **File names**: kebab-case for tests (`api.ping.test.js`)

### Error Handling

All tool handlers must return structured MCP responses:

```javascript
try {
  // ... operation
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
} catch (error) {
  return {
    content: [{ type: "text", text: `Error: ${error.message}` }],
    isError: true,
  };
}
```

### Tool Registration Pattern

```javascript
const { z } = require("zod");

function registerTools(registerTool) {
  registerTool(
    "tool_name",
    "Description of what the tool does",
    z.object({
      win_id: z.number().optional().default(1).describe("Window ID"),
      param: z.string().describe("Required parameter"),
    }),
    async ({ win_id, param }) => {
      try {
        // Implementation
        return { content: [{ type: "text", text: "result" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Category" } // OpenAPI grouping tag
  );
}

module.exports = registerTools;
```

### Response Formats

```javascript
// Text response
return { content: [{ type: "text", text: "message" }] };

// JSON response
return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };

// Image response (NativeImage from Electron)
return {
  content: [
    { type: "text", text: `Image: ${width}x${height}` },
    { type: "image", data: base64String, mimeType: "image/png" },
  ],
};

// Error response
return { content: [{ type: "text", text: "error message" }], isError: true };
```

### Common Patterns

#### Window Lookup

```javascript
const win = BrowserWindow.fromId(win_id);
if (!win) throw new Error(`Window ${win_id} not found`);
```

#### JSON Serialization with BigInt

```javascript
JSON.stringify(result, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
```

#### NativeImage Handling

```javascript
if (result?.constructor.name === "NativeImage") {
  const size = result.getSize();
  const base64 = result.toPNG().toString("base64");
  return {
    content: [
      { type: "text", text: `Image: ${size.width}x${size.height}` },
      { type: "image", data: base64, mimeType: "image/png" },
    ],
  };
}
```

### Testing Patterns

```javascript
const { setPort, setupTest, teardownTest, sendRequest } = require("./test-utils");

describe("Feature Test Suite", () => {
  beforeAll(async () => {
    setPort(8102); // Set test port
    await setupTest(); // Start Electron + establish SSE
  }, 30000);

  afterAll(async () => {
    await teardownTest(); // Cleanup
  });

  test("should do something", async () => {
    const response = await sendRequest("tools/call", {
      name: "tool_name",
      arguments: { param: "value" },
    });
    expect(response.result).toBeDefined();
  });
});
```

### Logging

Use electron-log with consistent format:

```javascript
const log = require("electron-log");
log.info("[MCP] Server starting");
log.error("[MCP] Error:", error);
```

### Security

- Never log secrets or API keys
- Validate all inputs with Zod schemas
- Return structured errors without internal details
- Auth token loaded from `~/data/electron/token.txt`

### Electron Best Practices

- Use `electronApp.whenReady()` for initialization
- Handle `window-all-closed` event properly
- Enable remote debugging with `--remote-debugging-port`
- Use `nodeIntegration: false` and `contextIsolation: true`
- Multi-account support via `partition: persist:sandbox-{accountIdx}`
