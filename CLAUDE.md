# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

### Install and run
```bash
npm install
npm start
npm run start:master
```

- `npm start` runs the local Electron worker via `bin/cicy-desktop`
- `npm run start:master` starts the control-plane master on port `8100` by default

### Formatting
```bash
npm run format
npm run format:check
```

### Tests
```bash
npm test
npx jest --runInBand tests/rpc/master-routes.test.js
npx jest --runInBand tests/rpc/cicy-rpc.test.js
npx jest --runInBand --testNamePattern="Master routes" tests/rpc/master-routes.test.js
```

Notes:
- Jest is configured in `jest.config.js` with `maxWorkers: 1`, global setup/teardown, and `forceExit: true`
- Tests under `tests/rpc/` commonly spin up the Electron worker or hit HTTP routes through supertest
- If you only need one file, prefer `npx jest --runInBand <path-to-test>`

### Build
```bash
npm run build
npm run build:win
npm run build:linux
```

### RPC CLI workflows
```bash
./bin/cicy-rpc init
./bin/cicy-rpc tools
./bin/cicy-rpc ping
CICY_NODE=windows ./bin/cicy-rpc ping
CICY_NODE=windows ./bin/cicy-rpc chrome_launch_profile accountIdx=1 url=https://example.com/
```

Important:
- `cicy` / `cicy-desktop` is for lifecycle management
- `cicy-rpc` is the RPC/tool CLI
- `cicy-rpc` reads `~/global.json`
- remote node selection is done with `CICY_NODE=<name>`

## Architecture

The codebase has two runtime roles:

1. **Worker**: an Electron desktop automation process exposing MCP-style tools and REST/RPC endpoints
2. **Master**: a lightweight control plane that tracks workers/agents/tasks and forwards `/api/rpc/:toolName` calls to a selected worker

### Worker runtime

The main worker entrypoint is `src/main.js`.

Key responsibilities there:
- initialize Electron flags, auth, logging, Express, and MCP plumbing
- load tool modules through `src/server/tool-catalog.js`
- register every tool into both the MCP server and REST/RPC surface
- expose worker metadata, agents, artifacts, and observability endpoints
- optionally register/heartbeat to a master when `CICY_MASTER_URL` and `CICY_MASTER_TOKEN` are present

Important supporting modules:
- `src/server/express-app.js`: base Express app, CORS, `/ping`, `/docs`, `/openapi.json`, and UI shell routes
- `src/server/mcp-server.js`: MCP transport setup
- `src/server/tool-registry.js`: tool registration bridge
- `src/server/tool-executor.js`: central execution path for REST/MCP tool calls
- `src/cluster/worker-client.js`: worker registration + heartbeat to the master
- `src/cluster/worker-identity.js`: worker identity payload advertised to the master

The worker exposes three important RPC surfaces:
- `GET /rpc/tools`
- `POST /rpc/tools/call`
- `POST /rpc/:toolName`

`POST /rpc/:toolName` is the simplest direct REST entrypoint and is what `cicy-rpc` uses after resolving the node from `~/global.json`.

### Tool system

Tool implementations live in `src/tools/*.js` and are loaded via `require("../tools")` from `src/server/tool-catalog.js`.

Each tool module exports a function that receives `registerTool(name, description, schema, handler, options)`. The resulting catalog is grouped by tag and then reused for:
- MCP tool registration
- `GET /rpc/tools`
- OpenAPI generation in `/openapi.json`

This means a tool definition change affects all three surfaces at once.

### Master runtime

The master entrypoint is `src/master/master-main.js`.

It maintains in-memory state for:
- `WorkerRegistry`: live registered workers
- `WorkerInventory`: merged view of configured nodes from `~/global.json` plus registered workers
- `AgentIndex`: worker agent metadata
- `TaskStore`: forwarded task records
- `SessionAffinityStore`: control-session routing affinity

Master routes are split into:
- `src/master/master-routes.js`: public API under `/api`
- `src/master/master-admin-routes.js`: admin-only routes under `/admin`

The most important master path is `POST /api/rpc/:toolName`:
- builds request context from `workerId`, `agentId`, runtime session, control session, and `accountIdx`
- chooses an execution target with `src/master/task-scheduler.js`
- creates a task record
- injects worker-specific fields like `win_id`, `agentId`, and `runtimeSessionId`
- forwards the request to the selected worker via `src/cluster/remote-executor`
- stores completion/failure state in `TaskStore`

### Chrome profile dispatch model

Chrome profile handling is split between master and worker.

Current model:
- the source-of-truth `chrome.json` lives on the **master** at `~/Private/chrome.json`
- workers are not required to have local `~/Private/chrome.json`
- workers only need a local template directory at `~/chrome/_tmp`

Master-side profile resolution:
- `src/master/chrome-config.js` reads master-local `~/Private/chrome.json`
- `src/master/master-routes.js` injects `effectiveChromeProfile` for forwarded chrome tool calls when `accountIdx` is present
- currently this injection is enabled for `chrome_launch_profile`, `chrome_get_profile`, `chrome_get_targets`, and `chrome_cdp_call`

Worker-side launch behavior:
- `src/tools/chrome-tools.js` implements chrome profile tools
- `chrome_launch_profile` now prefers injected `effectiveChromeProfile`
- if no injected profile is present, it falls back to local `~/Private/chrome.json` for backward compatibility
- if neither exists, it returns a clear error
- when a target user-data-dir does not exist, initialization is done from `~/chrome/_tmp`; if `_tmp` does not exist, it just creates the directory
- `orgPath -> Default` copy is only best-effort if the path exists on that worker

Chrome launch internals are intentionally separated:
- `src/chrome/chrome-launcher.js`: binary resolution, Chrome args, process spawn, debugger readiness
- `src/chrome/chrome-cdp-client.js`: `/json/version`, `/json/list`, activation, generic CDP calls
- `src/chrome/runtime-registry.js`: local runtime state tracking per account

### CLI/config split

There are two separate CLIs and that distinction matters:
- `bin/cicy-desktop` / `cicy`: local worker lifecycle management
- `bin/cicy-rpc`: RPC/tool invocation

`src/cli/rpc.js` is the source for `cicy-rpc`. It:
- reads `~/global.json`
- resolves `cicyDesktopNodes[<name>]`
- uses `CICY_NODE` to choose the target node
- POSTs directly to `/<rpc-path>` on that node with bearer auth

`cicy-rpc init` only initializes `~/global.json` if the file does not already exist. It is not a general node-management command.

## Config and auth

### `~/global.json`

This file is important for both RPC CLI usage and worker/master auth.

Relevant fields:
- top-level `api_token`
- `cicyDesktopNodes.<name>.base_url`
- `cicyDesktopNodes.<name>.api_token`

`cicy-rpc` chooses the token in this order:
1. `cicyDesktopNodes.<name>.api_token`
2. top-level `api_token`

### Worker registration to master

To run a worker attached to a master, the important env vars are:
```bash
MASTER_TOKEN=$(jq -r '.api_token' ~/global.json)
PORT=8101 CICY_MASTER_URL="http://127.0.0.1:8100" CICY_MASTER_TOKEN="$MASTER_TOKEN" npm start
```

The master itself uses `CICY_MASTER_TOKEN` or falls back to `MasterTokenManager`.

## File map for common tasks

- worker startup/runtime: `src/main.js`
- master startup/runtime: `src/master/master-main.js`
- master forwarding logic: `src/master/master-routes.js`
- configured node inventory from `~/global.json`: `src/master/worker-inventory.js`
- RPC CLI: `src/cli/rpc.js`
- worker tool catalog loading: `src/server/tool-catalog.js`
- tool execution plumbing: `src/server/tool-executor.js`
- Chrome tools: `src/tools/chrome-tools.js`
- Chrome launcher/CDP helpers: `src/chrome/chrome-launcher.js`, `src/chrome/chrome-cdp-client.js`
- cluster registration/heartbeat: `src/cluster/worker-client.js`
- RPC tests for forwarding and CLI behavior: `tests/rpc/master-routes.test.js`, `tests/rpc/cicy-rpc.test.js`

## Notes from existing docs

Important points already established in `README.md` and `AGENTS.md`:
- this repo no longer uses the old unified CLI mental model
- `cicy-rpc` is the canonical entrypoint for tool calls
- remote node operations should be thought of as `CICY_NODE=<name> cicy-rpc <tool> ...`
- tool modules use CommonJS and Zod schemas
- tests often exercise real HTTP routes and Electron-backed behavior rather than pure unit isolation
