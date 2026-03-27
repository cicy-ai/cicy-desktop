# REST API

This document describes the current HTTP API exposed by the CiCy Desktop worker.

Source of truth:
- worker entry: `src/main.js`
- OpenAPI/docs routes: `src/server/express-app.js`

## Endpoint summary

### Public endpoints

These do **not** require auth:

- `GET /ping` — basic health check
- `GET /docs` — Swagger-style API UI
- `GET /openapi.json` — generated OpenAPI spec

### Authenticated RPC endpoints

These **do** require auth:

- `GET /rpc/tools`
- `POST /rpc/tools/call`
- `POST /rpc/:toolName`
- `POST /rpc/upload/*`
- `POST /rpc/exec/:type`
- `GET /files`
- `GET /api/worker`
- `GET /api/agents`
- `GET /api/artifacts`

## Authentication

Authenticated routes expect:

```http
Authorization: Bearer <token>
```

Tokens are usually stored in `~/global.json` and are the same tokens used by `cicy-rpc`.

If auth fails, the worker responds with:

```json
{
  "error": "Unauthorized"
}
```

## Core RPC routes

### `GET /rpc/tools`

Returns the current tool catalog.

Example:

```bash
curl http://localhost:8101/rpc/tools \
  -H "Authorization: Bearer $TOKEN"
```

JSON response shape:

```json
{
  "tools": [
    {
      "name": "open_window",
      "description": "...",
      "inputSchema": {
        "type": "object"
      }
    }
  ]
}
```

YAML is also supported by setting:

```http
Accept: application/yaml
```

### `POST /rpc/tools/call`

Calls a tool by name using a generic wrapper endpoint.

Example:

```bash
curl -X POST http://localhost:8101/rpc/tools/call \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "open_window",
    "arguments": {
      "url": "https://example.com"
    }
  }'
```

Request shape:

```json
{
  "name": "tool_name",
  "arguments": {
    "key": "value"
  }
}
```

### `POST /rpc/:toolName`

Calls a tool directly.

Example:

```bash
curl -X POST http://localhost:8101/rpc/open_window \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "accountIdx": 0
  }'
```

This is the simplest REST form when you already know the tool name.

## Response format

Successful tool responses are wrapped like this:

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Pong"
      }
    ]
  }
}
```

Some tools return text content, some return structured JSON encoded in text, and some may return image content.

If the client sends:

```http
Accept: application/yaml
```

then tool responses are returned as YAML.

## JSON and YAML support

Current worker behavior:

- `GET /rpc/tools` supports JSON and YAML output via `Accept`
- `POST /rpc/tools/call` accepts JSON, and also accepts YAML when `Content-Type: application/yaml`
- `POST /rpc/:toolName` accepts JSON, and also accepts YAML when `Content-Type: application/yaml`
- tool responses can be returned as YAML when `Accept: application/yaml`

Example YAML tool call:

```bash
curl -X POST http://localhost:8101/rpc/exec_js \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/yaml" \
  -H "Accept: application/yaml" \
  --data-binary $'win_id: 1\ncode: document.title\n'
```

## Common examples

### Health check

```bash
curl http://localhost:8101/ping
```

### Ping tool

```bash
curl -X POST http://localhost:8101/rpc/ping \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Get windows

```bash
curl -X POST http://localhost:8101/rpc/get_windows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Open a window

```bash
curl -X POST http://localhost:8101/rpc/open_window \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "accountIdx": 0,
    "reuseWindow": true
  }'
```

### Execute JavaScript

```bash
curl -X POST http://localhost:8101/rpc/exec_js \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "win_id": 1,
    "code": "document.title"
  }'
```

## OpenAPI and interactive docs

The worker serves generated API docs directly:

- `GET /docs`
- `GET /openapi.json`

Examples:

```bash
open http://localhost:8101/docs
curl http://localhost:8101/openapi.json
```

## Errors

### 401 Unauthorized

```json
{
  "error": "Unauthorized"
}
```

### 400 Invalid YAML

```json
{
  "error": "Invalid YAML: ..."
}
```

### 500 Tool execution error

```json
{
  "error": "..."
}
```

If a tool raises a Zod validation error, the worker returns a `result` payload with `isError: true` instead of a generic HTTP 500.

## Related docs

- [Root README](../README.md)
- [CLI split](../skills/cicy-cli/README.md)
- [RPC CLI README](../packages/cicy-rpc/README.md)
