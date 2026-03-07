# REST API Feature

## ✅ Completed

Added REST API endpoints for all MCP tools with Swagger documentation.

## Features

### 1. REST Endpoints

Each tool now has its own REST endpoint:

```
POST /rpc/{toolName}
```

Examples:
- `POST /rpc/ping` - Health check
- `POST /rpc/open_window` - Open browser window
- `POST /rpc/get_windows` - List all windows
- `POST /rpc/close_window` - Close window
- `POST /rpc/exec_js` - Execute JavaScript
- `POST /rpc/cdp_click` - Click element
- `POST /rpc/cdp_screenshot` - Take screenshot

### 2. Swagger UI

Interactive API documentation at:

```
http://localhost:8101/api-docs
```

Features:
- Browse all available tools
- View request/response schemas
- Try out APIs directly in browser
- Authentication support

### 3. Tool Discovery

List all available tools:

```bash
GET /rpc/tools
```

Returns:
```json
{
  "tools": [
    {"name": "ping", "description": "..."},
    {"name": "open_window", "description": "..."},
    ...
  ]
}
```

## Usage

### Quick Start

```bash
# Run demo script
bash examples/rest-api-demo.sh
```

### Manual Testing

```bash
# Ping
curl -X POST http://localhost:8101/rpc/ping \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{}'

# Open window
curl -X POST http://localhost:8101/rpc/open_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"url":"https://example.com","accountIdx":0}'
```

### Automated Tests

```bash
cd tests/rpc
npm test rest-api.test.js
```

## Documentation

- **Full API Docs**: `docs/REST-API.md`
- **Swagger UI**: http://localhost:8101/api-docs
- **Examples**: `examples/rest-api-demo.sh`

## Benefits

1. **Simpler URLs**: `/rpc/ping` vs `/rpc` with JSON-RPC payload
2. **Standard HTTP**: Use any HTTP client
3. **Self-documenting**: Swagger UI for exploration
4. **Easy testing**: Direct curl commands
5. **Language agnostic**: Works with any HTTP library

## Comparison

### Before (JSON-RPC)

```bash
POST /rpc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "ping",
    "arguments": {}
  }
}
```

### After (REST)

```bash
POST /rpc/ping
{}
```

## Implementation

- Added dynamic route: `POST /rpc/:toolName`
- Integrated swagger-ui-express and swagger-jsdoc
- Added OpenAPI 3.0 annotations
- Maintained backward compatibility with JSON-RPC endpoint

## Files Changed

- `src/main.js` - Added REST routes and Swagger
- `tests/rpc/rest-api.test.js` - REST API tests
- `docs/REST-API.md` - Complete documentation
- `examples/rest-api-demo.sh` - Usage examples

## Next Steps

- ✅ REST endpoints working
- ✅ Swagger UI accessible
- ✅ Documentation complete
- ✅ Examples provided
- ⚠️ Test stability (service crashes on repeated window operations)

## Known Issues

- Service may crash when running full test suite (window operations)
- Individual REST calls work perfectly
- Recommend using service restart between test runs
