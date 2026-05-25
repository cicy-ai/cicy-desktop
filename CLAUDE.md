# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`cicy-desktop` is an Electron app that exposes ~50 system tools (Chrome control, clipboard, screenshot, shell exec, system info, ...) over MCP and REST/RPC. The app runs in two roles — **worker** (the Electron process exposing tools) and **master** (a thin control plane that routes tool calls across workers) — and ships a bundled `cicy-code` sidecar daemon so the desktop is a fully offline-capable backend.

## Development workflow rules (read first)

**This repo is edited in exactly one place.** Code changes happen on the main dev machine (Linux). The Mac is a **build host only** — it compiles and the user launches the resulting `.app`. Windows builds are produced by **GitHub Actions**, never on a local Windows checkout.

1. **Edit only on the main dev machine** (this Linux checkout at `~/projects/cicy-desktop`). Never `ssh mac` to edit `src/...`; that creates two-master divergence (the kind of issue rebase had to clean up in earlier sessions).
2. **Sync to Mac with `rsync`** before each Mac build:

   ```bash
   rsync -avz --delete \
     --exclude=node_modules --exclude=dist --exclude=.git \
     ~/projects/cicy-desktop/ mac:~/projects/cicy-desktop/
   ```

   Then on Mac: `cd ~/projects/cicy-desktop && npm install && npm run build:mac`. The user opens the resulting `.app` — the agent does NOT auto-launch it.
3. **Windows builds: GitHub Actions only.** Do not attempt local Windows builds. The workflow is already wired (see `.github/workflows/build-windows*.yml` / equivalents); just push to `main` and let CI produce the artifact.
4. **Commits / pushes happen on the Linux side.** Mac stays as a working-tree mirror; nothing committed there should be the source of truth. If Mac diverges, rsync overwrites.

## Common commands

### Install and run

```bash
npm install
npm start                          # local Electron worker via bin/cicy-desktop
npm run start:master               # control-plane master on port 8100
```

### Formatting

```bash
npm run format
npm run format:check
```

### Tests

```bash
npm test                                                          # full suite
npx jest --runInBand tests/rpc/master-routes.test.js              # single file
npx jest --runInBand --testNamePattern="Master routes" tests/rpc/master-routes.test.js
```

`jest.config.js` runs single-process (`maxWorkers: 1`) with `forceExit: true`. Tests under `tests/rpc/` spin up the real Electron worker or supertest HTTP routes, so they take real time and are not pure unit tests.

### Build & distribute

```bash
npm install
npm run build                  # multi-platform via electron-builder
npm run build:mac              # dist/CiCy Desktop-<ver>.dmg + .zip + dist/mac/CiCy Desktop.app
npm run build:win              # NSIS installer
npm run build:linux            # deb + AppImage
```

Dev iteration loop on macOS:

1. edit `src/...`
2. `pkill -f "MacOS/CiCy Desktop"` (electron-builder won't overwrite a running app)
3. `CICY_CODE_BIN_PATH=<path-to-cicy-code-binary> npm run build:mac`
4. `open "dist/mac/CiCy Desktop.app"`
5. inspect the packaged renderer via `npx --yes asar extract-file "dist/mac/CiCy Desktop.app/Contents/Resources/app.asar" <path>`

### RPC CLI workflows

```bash
./bin/cicy-rpc init
./bin/cicy-rpc tools
./bin/cicy-rpc ping
CICY_NODE=windows ./bin/cicy-rpc ping
CICY_NODE=windows ./bin/cicy-rpc chrome_launch_profile accountIdx=1 url=https://example.com/
```

Distinctions to internalize:

- `cicy` / `cicy-desktop` — local worker lifecycle (start/stop/status). **Not** for tool calls.
- `cicy-rpc` — tool invocation. Reads `~/global.json`. Choose remote node via `CICY_NODE=<name>`.

## Architecture

Two runtime roles:

1. **Worker** — an Electron process exposing tools over MCP and REST/RPC
2. **Master** — a thin control plane that tracks workers/agents/tasks and forwards `/api/rpc/:toolName` calls to a selected worker

A single host can run either or both. The bundled `.app` is normally a worker; running `npm run start:master` adds the master role.

### Worker runtime

Entrypoint: `src/main.js`.

Initializes Electron flags, auth, logging, Express, MCP plumbing, loads tool modules through `src/server/tool-catalog.js`, and registers every tool into both the MCP server and the REST/RPC surface. Registers + heartbeats to a master when `CICY_MASTER_URL` and `CICY_MASTER_TOKEN` are present.

Supporting modules:

- `src/server/express-app.js` — base Express app, CORS, `/ping`, `/docs`, `/openapi.json`, UI shell routes
- `src/server/mcp-server.js` — MCP transport setup
- `src/server/tool-registry.js` — tool registration bridge
- `src/server/tool-executor.js` — central execution path for REST/MCP tool calls
- `src/cluster/worker-client.js` — worker registration + heartbeat to the master
- `src/cluster/worker-identity.js` — identity payload advertised to the master

Worker RPC surface:

- `GET  /rpc/tools` — list registered tools
- `POST /rpc/tools/call` — `{ name, arguments }` style invocation
- `POST /rpc/:toolName` — direct REST entrypoint, what `cicy-rpc` uses after resolving the node

### Tool system

Tool implementations live in `src/tools/*.js` and are loaded via `require("../tools")` from `src/server/tool-catalog.js`. Each module exports a function receiving `registerTool(name, description, schema, handler, options)`. The catalog is grouped by `tag` and reused for:

- MCP tool registration
- `GET /rpc/tools`
- OpenAPI generation in `/openapi.json`

A tool definition change affects all three surfaces at once.

Tools use **CommonJS** and **Zod schemas**.

### Master runtime

Entrypoint: `src/master/master-main.js`.

In-memory state:

- `WorkerRegistry` — live registered workers
- `WorkerInventory` — merged view of configured nodes from `~/global.json` plus registered workers
- `AgentIndex` — worker agent metadata
- `TaskStore` — forwarded task records
- `SessionAffinityStore` — control-session routing affinity

Master routes split into:

- `src/master/master-routes.js` — public API under `/api`
- `src/master/master-admin-routes.js` — admin-only routes under `/admin`

The hot path is `POST /api/rpc/:toolName`:

1. build request context from `workerId`, `agentId`, runtime session, control session, `accountIdx`
2. choose an execution target with `src/master/task-scheduler.js`
3. create a task record in `TaskStore`
4. inject worker-specific fields (`win_id`, `agentId`, `runtimeSessionId`, `effectiveChromeProfile`)
5. forward to the selected worker via `src/cluster/remote-executor`
6. store completion/failure state

### Chrome profile dispatch

Chrome profile handling is split between master and worker. The source-of-truth `chrome.json` lives on the **master** at `~/cicy-ai/db/chrome.json`; workers don't need a local one.

Master-side:

- `src/master/chrome-config.js` reads master-local `~/cicy-ai/db/chrome.json`
- `src/master/master-routes.js` injects `effectiveChromeProfile` for forwarded chrome tool calls when `accountIdx` is present
- injection covers `chrome_launch_profile`, `chrome_get_profile`, `chrome_get_targets`, `chrome_cdp_call`

Worker-side launch (`src/tools/chrome-tools.js::chrome_launch_profile`):

- prefers injected `effectiveChromeProfile`
- falls back to local `~/cicy-ai/db/chrome.json` for backward compat
- if neither exists → clear error
- if target user-data-dir doesn't exist → initialize from `~/chrome/_tmp` (or just `mkdir`)
- `orgPath -> Default` copy is best-effort if the path exists

Chrome internals separated:

- `src/chrome/chrome-launcher.js` — binary resolution, args, spawn, debugger readiness, per-profile proxy via `--proxy-server=<url>`
- `src/chrome/chrome-cdp-client.js` — `/json/version`, `/json/list`, activation, generic CDP calls
- `src/chrome/runtime-registry.js` — local runtime state per account
- `src/chrome/debugger-port-resolver.js` — port assignment

Cross-platform Chrome discovery (`chrome-launcher.js::getBinaryCandidates`):

- macOS: `/Applications/Google Chrome.app`, `~/Applications/Google Chrome.app`, `/Applications/Chromium.app`
- Windows: `%LOCALAPPDATA%` / `%PROGRAMFILES%` / `%PROGRAMFILES(X86)%` under `Google\Chrome\Application\chrome.exe` (+ Chromium variants)
- Linux: `google-chrome` / `chromium` / `chromium-browser` from PATH

When none are present, launch errors with `"Chrome/Chromium binary not found"` — user must install Chrome first.

### Backends launcher (post-2.0.2)

The app no longer auto-loads a remote URL at startup. The first window shows a dashboard at `src/backends/homepage.html` listing configured backends.

- registry file: `<userData>/backends.json` — created on demand by `src/backends/registry.js`
- backend kinds: `local` (the bundled sidecar — see [Sidecar cicy-code daemon](#sidecar-cicy-code-daemon)) and `manual` (URLs added via the Add form, with optional token)
- preload bridge: `src/backends/homepage-preload.js` exposes
  - `cicy.backends.{list, add, remove, probe, open, health, healthAll, restartSidecar}`
  - `cicy.windows.*` for spawned backend windows
- IPC handlers: `src/backends/ipc.js`
- on cold load, `homepage.html` auto-opens the backend with the most-recent `lastUsedAt`. Skipped when `history.length > 1` (user navigated *back*), `?stay=1` URL param, or `sessionStorage["cicy-auto-opened"]` is set (per-session one-shot).

### Trust gate (`isTrustedUrl`)

`src/utils/window-utils.js::isTrustedUrl(url)` decides whether a `BrowserWindow` gets:

- `nodeIntegration: true`
- `contextIsolation: false`
- the `dom-ready` `electronRPC` auto-injection

Trusted hosts:

1. `localhost` / `127.0.0.1`
2. `*.de5.net`
3. **any hostname in `backends.json`** — anything the user added via the Add form (v2.0.2 widening)

Effect for renderers loading a trusted URL: `window.electronRPC(toolName, args)` is a function round-tripping through `ipcRenderer.invoke("rpc", toolName, args)` into the worker's tool registry.

### Bridge to cicy-code (`desktop_event` / `rpc_call`)

When this app opens a cicy-code backend, the server-side `agent-desktop` and `agent-chrome` skills reach Electron-main tools through cicy-code's chat WebSocket — **not** through this app's REST/RPC surface.

Flow:

1. cicy-code server posts `POST /api/chat/push` with `{ type: "desktop_event", data: { type: "rpc_call", tool, args, requestId } }`
2. cicy-code relays to the connected client over WebSocket
3. cicy-code's React app (`app/src/components/layout/useDesktopEvents.ts`) listens for `desktop_event`, sees `type === "rpc_call"`, awaits `window.electronRPC(tool, args)` — the same function the trust gate exposes
4. result dispatched as `rpc-result` CustomEvent → relayed back through the WS by `Workspace.tsx`
5. server-side skill (`hosttools.go::desktopRPC`) matches by `requestId` and returns

Why this exists: `agent-webpage exec-js` runs synchronously via `window.eval` and cannot await Promises, so it can't call `electronRPC` directly. `rpc_call` is the async-safe sibling.

Implication: anything that calls `window.electronRPC` from outside the cicy-code React tree must run inside a renderer where `isTrustedUrl` granted `nodeIntegration`, or where `homepage-preload.js` is the preload.

### Sidecar cicy-code daemon

`npm run build` runs `scripts/prepare-cicy-code-sidecar.js`, which copies the platform-matching `cicy-code` binary into `vendor/cicy-code/<platform>-<arch>/`. electron-builder bundles it as `extraResources`, ending up at `Contents/Resources/cicy-code/cicy-code` inside the `.app`.

Source resolution (first hit wins):

1. `CICY_CODE_BIN_PATH` — single binary, dev shortcut for the current host's platform/arch
2. `CICY_CODE_DIST_DIR` — directory with all four `cicy-code-{darwin,linux}-{amd64,arm64}` files from `bash build.sh all` in the cicy-code repo (CI path)
3. `../cicy-code/dist` — sibling checkout fallback

On macOS the copied binary is ad-hoc signed (`codesign --sign -`) so it loads on Apple Silicon without a Developer ID. Real signing happens in electron-builder's signing pass when configured.

The "Local (bundled)" entry in the Backends launcher uses this sidecar — the homepage spawns it as a child to provide a fully-offline backend.

### CLI/config split

Two CLIs, different jobs:

- `bin/cicy-desktop` / `cicy` — local worker lifecycle (start/stop/status)
- `bin/cicy-rpc` — tool invocation

`src/cli/rpc.js` (`cicy-rpc`):

- reads `~/global.json`
- resolves `cicyDesktopNodes[<name>]`
- uses `CICY_NODE` to choose the target node
- POSTs directly to `/<rpc-path>` on that node with bearer auth

`cicy-rpc init` only initializes `~/global.json` if missing. It is not a general node-management command.

## Config and auth

### `~/global.json`

```json
{
  "api_token": "cicy_…",
  "cicyDesktopNodes": {
    "mac":     { "base_url": "http://127.0.0.1:8101", "api_token": "…" },
    "windows": { "base_url": "http://1.2.3.4:8101",   "api_token": "…" }
  }
}
```

`cicy-rpc` picks the token in this order:

1. `cicyDesktopNodes.<name>.api_token`
2. top-level `api_token`

### Worker registration to master

```bash
MASTER_TOKEN=$(jq -r '.api_token' ~/global.json)
PORT=8101 CICY_MASTER_URL="http://127.0.0.1:8100" CICY_MASTER_TOKEN="$MASTER_TOKEN" npm start
```

The master uses `CICY_MASTER_TOKEN` directly or falls back to `MasterTokenManager`.

## File map

| What | Where |
|---|---|
| worker startup/runtime | `src/main.js` |
| master startup/runtime | `src/master/master-main.js` |
| master forwarding | `src/master/master-routes.js` |
| `~/global.json` inventory | `src/master/worker-inventory.js` |
| RPC CLI | `src/cli/rpc.js` |
| worker tool catalog | `src/server/tool-catalog.js` |
| tool execution plumbing | `src/server/tool-executor.js` |
| Chrome tools | `src/tools/chrome-tools.js` |
| Chrome launcher | `src/chrome/chrome-launcher.js` |
| Chrome CDP helpers | `src/chrome/chrome-cdp-client.js` |
| cluster registration | `src/cluster/worker-client.js` |
| backends registry | `src/backends/registry.js` |
| backends launcher UI | `src/backends/homepage.html` |
| backends preload bridge | `src/backends/homepage-preload.js` |
| BrowserWindow trust + auto-inject | `src/utils/window-utils.js` |
| sidecar packaging | `scripts/prepare-cicy-code-sidecar.js` |
| RPC test files | `tests/rpc/master-routes.test.js`, `tests/rpc/cicy-rpc.test.js` |

## Mental model checklist

When touching any of these, expect ripple effects:

- adding a tool → touches MCP server, REST/RPC, OpenAPI all at once via the catalog
- changing trust criteria → changes `nodeIntegration` for whole classes of windows; verify with the cicy-code bridge still works
- changing the homepage entry flow → check that cold-launch and "back to launcher" paths both behave (history.length / sessionStorage gates)
- changing the sidecar packaging → verify `dist/mac/CiCy Desktop.app/Contents/Resources/cicy-code/cicy-code` is present and executable after build
- changing `chrome_*` tools → both master injection (`effectiveChromeProfile`) and worker fallback (`~/cicy-ai/db/chrome.json`) paths still need to work
