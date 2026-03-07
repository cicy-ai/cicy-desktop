# REST API Documentation

## Overview

Electron MCP now provides REST API endpoints for each tool. Each tool can be called via:

```
POST /rpc/{toolName}
```

## Swagger UI

Interactive API documentation available at:

```
http://localhost:8101/api-docs
```

## Authentication

All endpoints (except `/ping`) require Bearer token authentication:

```bash
Authorization: Bearer <your-token>
```

Token location: `~/data/electron/token.txt`

## Available Endpoints

### List All Tools

```bash
GET /rpc/tools
```

**Example:**
```bash
curl -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  http://localhost:8101/rpc/tools
```

### Call a Tool

```bash
POST /rpc/{toolName}
Content-Type: application/json
```

## Examples

### 1. Ping

```bash
curl -X POST http://localhost:8101/rpc/ping \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{}'
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Pong"
    }
  ]
}
```

### 2. Get Windows

```bash
curl -X POST http://localhost:8101/rpc/get_windows \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{}'
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "[{\"id\":1,\"url\":\"https://example.com\"}]"
    }
  ]
}
```

### 3. Open Window

```bash
curl -X POST http://localhost:8101/rpc/open_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{
    "url": "https://example.com",
    "accountIdx": 0
  }'
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Opened window with ID: 1, use tool: get_window_info and wait window webContents dom-ready"
    }
  ]
}
```

### 4. Close Window

```bash
curl -X POST http://localhost:8101/rpc/close_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{
    "win_id": 1
  }'
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Closed window 1"
    }
  ]
}
```

### 5. Execute JavaScript

```bash
curl -X POST http://localhost:8101/rpc/exec_js \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{
    "win_id": 1,
    "code": "document.title"
  }'
```

### 6. CDP Click

```bash
curl -X POST http://localhost:8101/rpc/cdp_click \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{
    "win_id": 1,
    "selector": "button.submit"
  }'
```

### 7. Take Screenshot

```bash
curl -X POST http://localhost:8101/rpc/cdp_screenshot \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{
    "win_id": 1
  }'
```

## Error Handling

### Tool Not Found (404)

```json
{
  "error": "Tool not found: unknown_tool",
  "available": ["ping", "open_window", "get_windows", ...]
}
```

### Execution Error (500)

```json
{
  "error": "Window not found: 999"
}
```

### Unauthorized (401)

```json
{
  "error": "Unauthorized"
}
```

## Comparison: RPC vs REST

### JSON-RPC Style (Original)

```bash
POST /rpc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "open_window",
    "arguments": {"url": "https://example.com", "accountIdx": 0}
  }
}
```

### REST Style (New)

```bash
POST /rpc/open_window
{
  "url": "https://example.com",
  "accountIdx": 0
}
```

**Benefits:**
- ✅ Simpler URL structure
- ✅ Direct tool invocation
- ✅ Swagger documentation
- ✅ Standard HTTP semantics
- ✅ Easier to test with curl

## Testing

Run REST API tests:

```bash
cd tests/rpc
npm test rest-api.test.js
```

## Integration

### JavaScript/Node.js

```javascript
const axios = require('axios');
const fs = require('fs');

const token = fs.readFileSync(process.env.HOME + '/data/electron/token.txt', 'utf8').trim();

async function callTool(toolName, args) {
  const response = await axios.post(
    `http://localhost:8101/rpc/${toolName}`,
    args,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

// Usage
const result = await callTool('ping', {});
console.log(result);
```

### Python

```python
import requests
import os

token = open(os.path.expanduser('~/data/electron/token.txt')).read().strip()

def call_tool(tool_name, args={}):
    response = requests.post(
        f'http://localhost:8101/rpc/{tool_name}',
        json=args,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }
    )
    return response.json()

# Usage
result = call_tool('ping')
print(result)
```

## Available Tools

Get the full list dynamically:

```bash
curl -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  http://localhost:8101/rpc/tools | jq '.tools[].name'
```

Common tools:
- `ping` - Health check
- `get_windows` - List all windows
- `open_window` - Open new window
- `close_window` - Close window
- `get_window_info` - Get window details
- `exec_js` - Execute JavaScript
- `cdp_click` - Click element
- `cdp_screenshot` - Take screenshot
- `cdp_get_page_snapshot` - Get page HTML

See Swagger UI for complete list and schemas.
