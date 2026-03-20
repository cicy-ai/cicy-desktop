# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Electron-based MCP (Model Context Protocol) server that provides browser automation and web scraping capabilities. It exposes window management, Chrome DevTools Protocol (CDP) operations, and page interaction tools through a standardized MCP interface.

## Development Commands

### Starting the Server
```bash
# Start MCP server (default port 8101)
npm start

# Start with custom port
npm start -- --port=8102

# Start in test mode with environment variables
export URL=https://www.google.com
export TEST=true
export DISPLAY=:1
npx electron main.js
```

### Testing
```bash
# Run complete test suite
npm test

# Run specific test categories
npm run test:api          # Basic API tests
npm run test:cdp          # All CDP tools tests
npm run test:cdp-mouse    # CDP mouse operations
npm run test:cdp-keyboard # CDP keyboard operations
npm run test:cdp-page     # CDP page operations

# Run single test with pattern
npm test -- --testNamePattern="cdp_click"
```

### Development Setup
```bash
# Install dependencies
npm install

# Kill existing processes on port
pkill electron
```

## Architecture

### Core Components

**main.js** - Main application file containing:
- `ElectronMcpServer` class - Core MCP server implementation
- Tool registration system using `registerTool()` method
- HTTP server with SSE (Server-Sent Events) transport
- Authentication token management
- Network monitoring and resource capture system

**start-mcp.js** - Server launcher with:
- Port management and conflict resolution
- Background process spawning
- Logging system (~/logs/cicy-desktop.log)
- Process lifecycle management

**snapshot-utils.js** - Screenshot utilities:
- Page capture with automatic macOS scaling
- Clipboard integration
- MCP-compatible image format conversion

### MCP Tool Categories

1. **Window Management**: `get_windows`, `open_window`, `close_window`, `load_url`, `get_title`
2. **Code Execution**: `invoke_window`, `invoke_window_webContents`, `invoke_window_webContents_debugger_cdp`
3. **CDP Mouse**: `cdp_click`, `cdp_double_click`
4. **CDP Keyboard**: `cdp_press_key`, `cdp_type_text`, `cdp_press_key_enter`, etc.
5. **CDP Page**: `cdp_scroll`, `cdp_find_element`, `cdp_execute_script`, `cdp_get_page_title`
6. **Screenshots**: `webpage_screenshot_to_clipboard`
7. **System**: `ping`

### Authentication System

- Auto-generates authentication tokens stored in `~/global.json`
- All HTTP requests require `Authorization: Bearer <token>` header
- Token validation in `validateAuth()` method

### Network Monitoring

The server automatically captures network resources when pages load:
- Monitors Network.* CDP events
- Saves resources by type: html, json, js, css, images
- Organizes by domain in `~/data/captured_data/`
- Prettifies JSON and code content

## Key Implementation Details

### Tool Registration Pattern
```javascript
this.registerTool(
  "tool_name",
  "Description in Chinese",
  { param: z.string().describe("Parameter description") },
  async ({ param }) => {
    // Implementation
    return { content: [{ type: "text", text: "Result" }] };
  }
);
```

### Code Execution Context
- `invoke_window`: Access to `win` (BrowserWindow) and `webContents` objects
- `invoke_window_webContents`: Access to `webContents` and `win` objects
- `invoke_window_webContents_debugger_cdp`: Access to `debuggerObj`, `webContents`, `win`

### Error Handling
- All tools return `{ isError: true }` for failures
- Comprehensive error messages with stack traces
- Parameter validation using Zod schemas

### Test Architecture
- Uses Jest with supertest for HTTP API testing
- SSE connection management for real-time communication
- Comprehensive CDP tool coverage (33 test cases)
- Automatic Electron process lifecycle management
- Authentication token integration

## Common Patterns

### Adding New Tools
1. Use `registerTool()` in the `setupTools()` method
2. Follow the established parameter validation pattern with Zod
3. Add corresponding test cases in `tests/api.test.js`
4. Update documentation

### CDP Operations
- Always check if debugger is attached: `debuggerObj.isAttached()`
- Attach with version: `debuggerObj.attach('1.3')`
- Use `sendCommand()` for CDP protocol calls
- Handle async operations with proper await

### Window Management
- Window IDs are used consistently across all window operations
- Default window ID is 1 when not specified
- Always validate window existence before operations

## Environment Variables

- `PORT`: Server port (default: 8101)
- `TEST`: Enable test mode with auto-window creation
- `URL`: Default URL for test window
- `DISPLAY`: X11 display for headless environments
- `NODE_ENV`: Environment mode (test/development/production)

## File Structure Notes

- Main server logic in `main.js` (1141 lines)
- Comprehensive test suite in `tests/api.test.js` (712 lines)
- Utility functions separated in `snapshot-utils.js`
- Process management in `start-mcp.js`
- All dependencies managed through `package.json`