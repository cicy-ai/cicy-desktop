# Claude Code Handoff

Please read this file first, then read `AGENTS.md`, and then inspect the codebase.

## Project Summary

`cicy-desktop` is an Electron-based desktop automation host. It is not just a normal desktop app; it acts as a:

- Electron runtime
- browser/desktop automation host
- MCP + HTTP RPC + admin UI control plane
- evolving master/worker distributed desktop platform

## Read These Files First

Start with these files in this order:

1. `AGENTS.md`
2. `src/main.js`
3. `src/master/master-main.js`
4. `src/master/master-routes.js`
5. `src/cluster/worker-client.js`
6. `src/cluster/worker-identity.js`
7. `src/server/tool-registry.js`
8. `src/utils/window-utils.js`
9. `src/utils/window-monitor.js`
10. `src/tools/window-tools.js`
11. `docs/feature-distributed-multi-agent.md`

## Architecture Overview

### Worker Runtime
- Main worker entry: `src/main.js`
- Exposes:
  - MCP SSE endpoints
  - HTTP RPC endpoints
  - admin/UI routes
  - Electron IPC bridge
- Registers tools from `src/tools/*`
- Manages BrowserWindow lifecycle
- Supports automation, screenshots, CDP, DOM actions, downloads, requests, logs, and system window operations

### Master Runtime
- Main master entry: `src/master/master-main.js`
- API routes in `src/master/master-routes.js`
- Tracks workers, agents, tasks, and session affinity
- Exposes worker/task/agent APIs and RPC forwarding

### Tool Registry
- Central registration point: `src/server/tool-registry.js`
- Tool modules live in `src/tools/*`
- Tool handlers are reused across protocols

### Window/Agent Foundation
- Window lifecycle core: `src/utils/window-utils.js`
- Monitoring/telemetry core: `src/utils/window-monitor.js`
- A BrowserWindow is effectively the current agent runtime unit
- Multi-account/session isolation uses Electron partitioning

## Current Distributed State

The repository already contains early master/worker support.

### Already Implemented
- Worker identity generation
- Worker client registration flow
- Worker heartbeat flow
- Master worker registry
- Agent index
- Task store
- Session affinity store
- Master RPC forwarding to workers
- Master admin HTML/UI routes

### Main Endpoints

#### Master
- `GET /api/ping`
- `POST /api/workers/register`
- `POST /api/workers/heartbeat`
- `GET /api/workers`
- `GET /api/agents`
- `GET /api/tasks`
- `POST /api/rpc/:toolName`
- `GET /master`

#### Worker
- `GET /rpc/tools`
- `POST /rpc/tools/call`
- `POST /rpc/:toolName`
- `GET /ui`
- `GET /docs`

## Known Operational Facts

### Master Start
```bash
cd /Users/ton/projects/cicy-desktop
npm run start:master
```

### Worker Start
```bash
MASTER_TOKEN=$(jq -r '.master_token' ~/.cicy-master.json)
PORT=8101 CICY_MASTER_URL="http://127.0.0.1:8100" CICY_MASTER_TOKEN="$MASTER_TOKEN" npm start
```

### Important Runtime Requirements
Worker registration to master fails if any of the following are wrong:

1. `CICY_MASTER_URL` is missing
2. `CICY_MASTER_TOKEN` is missing
3. worker port (for example `8101`) is already occupied
4. wrong Node runtime is used

### Node Version Note
This project runs better with Node 22 in this environment. Node 19 caused startup/runtime issues.

## Recently Confirmed Issue

A worker previously failed to appear in master because:
- port `8101` was already in use by another Electron process
- worker startup environment was not consistently correct

After killing the conflicting process and starting the worker with:
- Node 22
- `CICY_MASTER_URL`
- `CICY_MASTER_TOKEN`

registration succeeded.

## What This Project Is Right Now

Best current description:

> A mature single-node Electron automation worker runtime with early but working master/worker distributed plumbing.

It is **not yet** a fully mature distributed desktop cluster, but it already has the first working pieces.

## What Is Still Missing / Incomplete

Likely gaps still needing work:
- richer agent abstraction beyond raw BrowserWindow
- stronger task lifecycle orchestration
- worker health/resource reporting polish
- clearer worker startup/desktop launch flow
- better master UI observability for workers/agents/tasks
- more robust retry/error handling in master-to-worker forwarding

## What To Do First

Before changing code:
1. Read the files listed above
2. Summarize current architecture in your own words
3. Explain what master/worker currently implements
4. Identify the most important missing pieces
5. Propose the next incremental step before editing code

## Expected First Response

Please start by answering:

1. What is the current architecture?
2. What exactly is already implemented for master/worker?
3. What is missing or fragile?
4. What should be the next priority?

Do not start editing immediately. Read first, then propose a plan.
