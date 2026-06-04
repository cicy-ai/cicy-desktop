# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`cicy-desktop` is an Electron app that exposes ~100+ system tools (Chrome control, CDP, clipboard, screenshot, shell/node/python exec, system info, file ops, ...) over MCP and REST/RPC. The app runs in two roles — **worker** (the Electron process exposing tools) and **master** (a thin control plane that routes tool calls across workers). It does **not** bundle a `cicy-code` binary — the sidecar daemon is acquired at runtime (`npx cicy-code` on mac/linux, Docker on Windows; see [Sidecar](#sidecar-cicy-code-daemon)).

**Distribution (2026-06):** end users run via npm, not a packaged installer — `npx cicy-desktop` (mac/linux) / `npm i -g cicy-desktop && cicy-desktop` (Windows). First launch drops a desktop shortcut and auto-acquires the sidecar. CN needs `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` so electron's binary postinstall doesn't hit GitHub. The electron-builder packaged build (dmg/NSIS) still exists but is secondary. To discover tools at runtime, call the `list_tools` meta-tool (`electronRPC("list_tools")` / `agent-desktop rpc list_tools`).

## Development workflow rules (read first)

**This repo is edited in exactly one place** — the Linux dev machine. Mac is a runtime mirror for macOS-side validation; Windows is a separate runtime mirror that always rides the production CF Worker. There are **two iteration loops**: a fast one for React UI work (Mac, HMR) and a slow one for packaged-build validation. Pick whichever matches what you're touching.

### Platform routing

| Role | Where the SPA comes from | When to use |
|---|---|---|
| **Mac dev** | Vite dev server on Mac (`localhost:8173`) loaded by source-mode Electron | Loop A — any edit to `workers/render/src/**` (React UI), HMR live |
| **Mac packaged** | bundled `file://src/backends/homepage-react/` inside the .app | Loop B — release-shaped validation (main-process / preload / IPC changes) |
| **Windows** | remote `https://desktop.cicy-ai.com/` (CF Worker `desktop-render`) | Always. Win NSIS package + electron-updater auto-pulls newer releases. SPA changes ship via `wrangler deploy`, no rebuild needed |

Linux never runs Electron. Linux never serves the SPA to Mac. Edits + commits + the CF Worker deploy all happen here; the Mac and Win machines are pure runtime mirrors.

### Loop A — fast (Mac-native Vite + source-mode Electron)

Use this for anything in `workers/render/src/` (React UI, CSS, App.jsx). React + Vite **HMRs** without restarting Electron. No SSH tunnel involved — Vite and Electron both run on Mac, so the URL is genuinely local.

```bash
# 1. Linux dev: sync source to Mac
rsync -avz --delete \
  --exclude=node_modules --exclude=dist --exclude=.git \
  ~/projects/cicy-desktop/ mac:~/projects/cicy-desktop/

# 2. Mac: start the Vite dev server (first time also: `npm install` in workers/render)
ssh mac
cd ~/projects/cicy-desktop/workers/render && nohup npm run dev > /tmp/vite-dev.log 2>&1 &
# Vite listens on localhost:8173

# 3. Mac: kill any installed .app then run Electron from source
#    .env.dev already sets CICY_HOMEPAGE_URL=http://localhost:8173, so
#    source-mode Electron loads the live Vite bundle (HMR enabled) instead
#    of the bundled file:// one.
pkill -f "MacOS/CiCy Desktop" 2>/dev/null
cd ~/projects/cicy-desktop && npm install   # first time only
nohup bash -c 'set -a; . ./.env.dev; set +a; npm start' > /tmp/cicy-desktop-dev.log 2>&1 &
```

Now: edit `workers/render/src/App.jsx` on Linux → `rsync` to Mac → HMR picks it up instantly. **No Electron restart needed** for React/CSS changes.

For continuous syncing during a session, run a one-shot rsync after each save, or set up `fswatch` / IDE-side sync. Whatever you do, the source of truth stays on Linux.

### Loop B — packaged build (only for release validation)

```bash
# Linux: full sync (same as Loop A step 1)
rsync -avz --delete \
  --exclude=node_modules --exclude=dist --exclude=.git \
  ~/projects/cicy-desktop/ mac:~/projects/cicy-desktop/

# Mac: build the .app (electron-builder won't overwrite a running one)
ssh mac
cd ~/projects/cicy-desktop
pkill -f "MacOS/CiCy Desktop" 2>/dev/null
CICY_CODE_BIN_PATH=<path-to-cicy-code-binary> npm run build:mac
open "dist/mac/CiCy Desktop.app"
```

### Windows side — CF Worker is the SPA delivery path

Win never runs Vite or source-mode Electron. The Win NSIS package's main process loads `https://desktop.cicy-ai.com/`, which is the `desktop-render` Worker on Cloudflare serving `workers/render/dist/`. To ship a SPA change to Win users without releasing a new desktop package:

```bash
# Linux dev: build + deploy SPA
cd ~/projects/cicy-desktop/workers/render
npm run build
CLOUDFLARE_ACCOUNT_ID=$(jq -r .cf.prod.account_id ~/cicy-ai/global.json) \
CLOUDFLARE_API_TOKEN=$(jq -r .cf.prod.api_token ~/cicy-ai/global.json) \
  npx wrangler deploy
# Also mirror into the file:// folder for Mac packaged builds
rsync -av --delete dist/ ../../src/backends/homepage-react/
```

Win users see the new SPA on next desktop relaunch (no auto-reload — they have to restart cicy-desktop). For main-process / preload changes Win needs an actual NSIS rebuild + electron-updater push (see `## Build & distribute`).

### Loop A failure modes

The Mac-native loop has no SSH tunnel to drop, but it has three other failure shapes:

1. **Vite died** (terminal closed, OOM, port conflict)
   ```bash
   ssh mac "curl -sI http://localhost:8173/ -m 4 | head -1"
   # Connection refused → Vite down. Restart with step 2 of Loop A.
   ```

2. **The bundled .app is running instead of source-mode Electron** (it'll happily load Vite at 8173 if `.env.dev` is sourced, but more often Mac auto-launches the .app and you forget to kill it)
   ```bash
   ssh mac 'ps -ef | grep "MacOS/CiCy Desktop" | grep -v grep'
   # If you see /Applications/CiCy Desktop.app/... — that's the packaged one.
   # pkill -f "MacOS/CiCy Desktop" then re-run Loop A step 3.
   ```

3. **Electron loaded a stale URL** (`.env.dev` not sourced, fallback to `file://` or `desktop.cicy-ai.com`). Inspect the live URL over CDP:
   ```bash
   ssh mac 'curl -s http://127.0.0.1:9221/json | python3 -c "
   import sys, json
   for t in json.load(sys.stdin):
       print(t.get(\"type\"), t.get(\"url\",\"\")[:80])"'
   # If url is anything other than http://localhost:8173/, source-mode wasn't
   # picked up cleanly. Re-export CICY_HOMEPAGE_URL and restart Electron.
   ```

### The three reload classes (the trap that wastes hours)

Electron has three independent execution contexts. **Each has its own reload rule**, and they don't share. Knowing which class your file belongs to is the difference between a 2-second iteration and a 30-second one.

| Class | Files | Reload trigger |
|---|---|---|
| **Vite render** | `workers/render/src/**` — App.jsx, App.css, any imported JS | ✅ **HMR**. Save → instant. No Electron restart. |
| **Preload** | `src/backends/homepage-preload.js`, `src/backends/webview-preload.js` | ❌ **Full Electron restart**. Preloads load once at BrowserWindow creation. `⌘+R`/devtools reload does NOT re-read them. |
| **Main process** | `src/main.js`, `src/backends/*.js` required by main (e.g. `local-teams.js`), IPC handler registration, any tool module | ❌ **Full Electron restart**. Main runs in Node and is never reloaded by the renderer. |

**The silent failure pattern**: React (Vite) HMRs to a new App.jsx that calls `window.cicy.someNewField`. If the **preload** still exposes the old surface, `someNewField` is `undefined` and your code paths silently misbehave. Always check that preload changes have actually landed by inspecting `window.cicy` over CDP (see [Debugging](#debugging-via-remote-debugging-port-9221)).

### Where edits go

- **Edit only on Linux** at `~/projects/cicy-desktop`. Never `ssh mac` to edit `src/...` — that creates two-master divergence (the kind of mess earlier rebases had to clean up).
- **Commits / pushes from Linux.** Mac is a working-tree mirror; nothing committed there should be the source of truth.
- **Windows builds: GitHub Actions only** (see `.github/workflows/build-windows*.yml`). Don't try local Windows builds.

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

Worker tool surface (how the ~100 tools are reached):

- **IPC** — `ipcMain.handle("rpc", (e, toolName, args) => executeTool(...))` (`src/main.js`). This is what `window.electronRPC(tool, args)` and the cicy-code `desktop_event` bridge ride. No HTTP, no port.
- **MCP** — every registered tool is exposed via the MCP server (`src/server/mcp-server.js`, `/mcp` + `/messages`).
- **HTTP index** — `GET /openapi.json` (dynamic, every tool + inputSchema) and the Swagger UI at `/docs`.
- **`list_tools`** — a meta-tool (`src/tools/list-tools.js`) that returns the live catalog over the IPC/RPC side, so callers that can't reach `/openapi.json` (renderer, `<webview>`, `agent-desktop rpc list_tools`) can still enumerate.
- **REST `POST /rpc/:toolName`** — served by the **master** (`src/master/master-routes.js`), which forwards to a worker. The worker process itself does not mount `/rpc/*` execution routes.

### Tool system

Tool implementations live in `src/tools/*.js`, listed in `src/tools/index.js`, loaded via `require("../tools")` from `src/server/tool-catalog.js`. Each module exports a function receiving `registerTool(name, description, schema, handler, options)`. The catalog (grouped by `tag`) is reused for MCP registration, `list_tools`, and OpenAPI generation in `/openapi.json` — **a tool definition change affects all of them at once.**

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

### Homepage UI (Vite + React subproject)

The first window's UI is a **Vite + React subproject** at `workers/render/`, **not** the older `src/backends/homepage.html`. Treat them as independent codebases that happen to live in the same repo.

- entry: `workers/render/src/App.jsx` + `App.css`
- dev server: `workers/render/vite.config.js` → `0.0.0.0:8173`
- prod bundle: `workers/render/dist/index.html` (Electron loads via `file://` fallback when `CICY_HOMEPAGE_URL` is unset — see `src/backends/homepage-window.js:pickHomepageURL`)
- BrowserWindow config (`src/backends/homepage-window.js`):
  - `preload: src/backends/homepage-preload.js`
  - `webviewTag: true` + `allowRunningInsecureContent: true` (the right-side Team Helper drawer is a `<webview>` loading a remote http:// SPA)
  - `sandbox: false` + `contextIsolation: true`

Day-to-day UI work happens entirely here. The Linux dev machine runs `npm run dev` in this subproject; the Mac's Electron loads from it via `CICY_HOMEPAGE_URL=http://localhost:8173` (see [Loop A](#loop-a--fast-vite--ssh--r--electron-from-source)).

### Preload bridges — `homepage-preload.js` vs `webview-preload.js`

Two distinct preload files because they run in different webContents with different security needs:

`src/backends/homepage-preload.js` — loaded into the **main BrowserWindow**'s renderer (the Vite/React UI). Exposes the full host surface the React app needs:

- `window.electronRPC(tool, args)` — generic dispatch into the worker tool registry (any tool from `src/tools/*.js`)
- `window.cicy.localTeams.{list, open, add, remove, update, upgrade, onWebviewRelay, replyWebviewRelay}`
- `window.cicy.cloud.fetch(url, opts)` — main-process `fetch` proxy (sidesteps CORS for `cicy-ai.com` calls; renderer's `localhost:8173` / `file://` origins aren't on the cloud's CORS allowlist)
- `window.cicy.auth.{loginStart, loginCancel, onComplete}` — browser-loopback login flow (`src/backends/auth-loopback.js`)
- `window.cicy.app.*`, `window.cicy.windows.*`, `window.cicy.shell.openExternal`, etc.
- `window.cicy.preloadPath` (legacy) and `window.cicy.webviewPreloadPath` — absolute paths the React code reads to wire the right-drawer `<webview preload={...}>`

`src/backends/webview-preload.js` — loaded into the **right-drawer `<webview>`** that hosts the cloud Team Helper SPA. Deliberately **TINY** because the webview loads a remote (third-party) SPA:

- `window.electronRPC(tool, args)` — same generic dispatch (the cloud helper's `agent-desktop` skill needs it to run shell commands on the user's machine)
- `window.cicy.localTeams.{list, add, remove, update, upgrade}` — all five go through `webview:relay` (next section), not directly to main

We don't reuse `homepage-preload.js` here because (1) it `require()`s non-electron modules (`../i18n`) that throw in the webview's sandboxed context, half-killing the preload before any contextBridge runs, and (2) exposing `cicy.backends.*` / `cicy.sidecar.*` / `cicy.auth.*` to a cloud SPA is unnecessary attack surface.

### `webview:relay` — webview ↔ host renderer authority pattern

The Team Helper webview can't be allowed to mutate `~/cicy-ai/global.json` directly — that's the host renderer's UX decision. So `webview-preload.js`'s `cicy.localTeams.*` methods relay through main to the host renderer (App.jsx), wait for its reply, and return the result to the webview's awaited promise.

```
webview                          main process              host renderer (App.jsx)
  │                                  │                          │
  ipcRenderer.invoke                 │                          │
  ("webview:relay", msg)             │                          │
  ──────────────────────────────▶  ipcMain.handle               │
                                     │                          │
                                     host.send                  │
                                     ("webview:relay",          │
                                      {reqId, msg})             │
                                     ─────────────────────────▶ onWebviewRelay handler
                                                                  │
                                                                  await window.cicy.localTeams.add(spec)
                                                                  fetchLocalTeams()         ← UI refresh
                                                                  │
                                                                  ipcRenderer.send
                                     ◀────────────────────────── ("webview:relay-reply",
                                                                  {reqId, result})
                                     resolve(result)              │
  ◀──────────────────────────────  │                          │
  promise resolves                   │                          │
```

15s timeout in main if the host renderer never replies. The host renderer is the only place that actually calls `localTeams:add/remove/update/upgrade` IPCs against `local-teams.js`. This keeps add/remove/upgrade authoritative for the UX (it can confirm/deny + refresh state) while still giving the webview real awaitable promises.

### Team Helper drawer (cloud SPA in `<webview>`)

The right-side drawer in App.jsx hosts a cloud-trial agent that walks new users through installing a local `cicy-code` backend, then hands them off to their own local helper:

- `HELPER_URL_BASE` (App.jsx constant): URL of the cloud helper container — currently `http://43.99.56.150:8011`. The container is built from `cicy-cloud/workers/helper/` (separate repo).
- `HELPER_SHARED_TOKEN`: the cloud container's `api_token`. Regenerated on every container restart; must be re-pasted into App.jsx whenever the cloud helper is rebuilt.
- `HELPER_PANE_ID = "w-6002:main.0"` — the `Team Helper` opencode pane the cloud `cicy-code --helper=1` mode pins.

The webview `src` is `${HELPER_URL_BASE}/?token=${token}#/agent/w-6002`. Once `agent-webpage helper-init` returns the user's OS / arch / network reachability, the cloud agent downloads `cicy-code` to the user's machine and registers the new team via `await window.cicy.localTeams.add({...install_source: "helper-mac-linux"...})`. App.jsx detects `install_source` starting with `helper-` and **auto-swaps `helperUrl`** 2.5 s later to `<new team base_url>/?token=...#/agent/w-6002`. From that point the drawer is the user's own long-lived local Team Helper — no 30-min cap, same task surface (install / upgrade / token-rotate / remove / open).

The "send `start`" centered modal in the drawer is a manual fallback for when the server-side helper-kick goroutine (cicy-code's `watchHelperOpencodeReadyAndKick`) didn't fire — e.g. the user reopened the drawer too quickly. Local-storage key `helper_modal_suppressed` records "Don't show again".

#### Helper token rotation workflow

Every cloud-helper rebuild generates a fresh `api_token`. `HELPER_SHARED_TOKEN` in App.jsx must be updated to match, otherwise the drawer's `<webview src=…?token=…>` and the renderer's `cloud.fetch` calls 401 against the helper. Standard loop (already proven against both local-Docker and the remote `43.99.56.150` helper, which accepts the same token):

```bash
# 1. Grab the new token straight out of the helper container's global.json
docker exec cicy-helper grep api_token /home/cicy/cicy-ai/global.json
#   "api_token": "cicy_XXXXXXXX…",

# 2. Paste it into workers/render/src/App.jsx HELPER_SHARED_TOKEN
#    Vite HMR's the constant change into the running renderer immediately,
#    no Electron restart needed for THIS step (the webview keys off helperUrl
#    so it remounts with the new token).

# 3. rsync to Mac so its source matches Linux (vite-dev tunnel still works,
#    but explicit sync prevents drift if you later switch loops).
rsync -avz --delete \
  --exclude=node_modules --exclude=dist --exclude=.git \
  --exclude=workers/render/node_modules --exclude=workers/render/dist \
  ~/projects/cicy-desktop/ mac:~/projects/cicy-desktop/
```

Only the **token** HMRs cleanly. If you also rebuilt the helper image with new AGENTS.md / new preload-relevant code, the cloud SPA in the webview is fine to reload (it's served by the container), but anything on the Electron side (homepage-preload, webview-preload, main, local-teams.js) is a full `⌘+Q` + reopen as usual.

`HELPER_URL_BASE` (App.jsx) is the **other** half of the pairing. It currently points at `http://43.99.56.150:8011` (a long-running shared helper). If you want to swap to a locally rebuilt container, change it to `http://localhost:8011` and `ssh -fNR 8011:127.0.0.1:8011 mac` so the Mac can reach your dev box's helper. Same token-grab step still applies.

### Deep links (`cicy://`) and local-team add/rename

Protocol `cicy://` is registered (`package.json` build `protocols` + `setAsDefaultProtocolClient("cicy")` in `src/main.js`). The handler is `src/main.js::handleDeepLink(url)`, fed by `app.on("open-url")` (mac), `second-instance`, and cold-start `argv` (win/linux).

`cicy://addTeam?title=<t>&url=<base_url>&token=<api_token>`:

- **handleDeepLink adds the team directly in the main process** via `local-teams.addTeam({base_url, api_token, name})` — it does NOT rely on the renderer. (An earlier version only broadcast `deeplink:addTeam` to the renderer, but App.jsx never wired `window.cicy.deeplink.onAddTeam`, so the team was silently dropped.) The homepage polls `localTeams:list` every few seconds, so the new team shows up on its own.
- **Upsert is keyed by `base_url`** (`local-teams.js::addTeam`): re-adding a known URL refreshes `api_token` + install meta but **keeps the existing (possibly user-renamed) name** — only a brand-new team takes the provided title. No-name → i18n default `localTeams.unnamed` (`Unnamed`/`未命名`/…).
- The URL value must be **single** percent-encoded; raw CJK in `title` makes macOS `open` re-encode the whole thing (double-encoding → `bad base_url`).

**Rename**: every local team is renamable. `LocalTeamCard` (App.jsx) has inline edit (double-click name / ✎) → `window.cicy.localTeams.update(id, {name})` → `local-teams.js::updateTeam` (whitelists `name`). Labels go through `window.cicyI18n.t` (preload-exposed i18n; keys in `src/i18n/locales/*.json` under `localTeams`).

### Backends launcher (legacy `src/backends/`)

`src/backends/homepage.html` + `cicy.backends.{list, add, remove, …}` is the **pre-Vite** launcher. It still ships and still works (the bundled sidecar and Add-by-URL flow live here), but it is **not** what new users see — `pickHomepageURL` prefers the Vite/React entry. Touch this only when you're working on the old launcher path. Registry file: `<userData>/backends.json` (`src/backends/registry.js`). IPC handlers: `src/backends/ipc.js`.

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

### On-disk layout — `~/.local/bin/cicy-code` symlink → versioned binary

The cloud Team Helper agent writes the daemon into the user's `~/.local/bin/` with this shape (the npx sidecar path uses the npm cache instead, but a Helper-installed `~/.local/bin/cicy-code` on `:8008` is still reused first via `probeExisting`, and `upgradeNative` manages it):

```
~/.local/bin/cicy-code-2.1.8      (actual binary, +x)
~/.local/bin/cicy-code-2.1.9      (next version after upgrade)
~/.local/bin/cicy-code            (symlink → cicy-code-2.1.9, atomic-swapped on upgrade)
```

Rationale:

- **Atomic upgrade**: `ln -sfn cicy-code-<new> ~/.local/bin/cicy-code` is a POSIX-atomic relink. A long-running daemon spawned via the symlink keeps its current inode open; future re-spawns pick up the new target.
- **Rollback**: old versioned binaries stay on disk. Rolling back is one symlink swap.
- **Version-from-disk**: `fs.readlinkSync(~/.local/bin/cicy-code)` and parsing the basename gives the current version — no separate `version` file to keep in sync. Legacy fallback to a `<binDir>/version` file is kept in `installer.userVersion()` for older installs.

Upgrade flow inside `src/backends/local-teams.js::upgradeNative`:

1. `fetchManifestVersion()` learns the upcoming version (so the download filename is `cicy-code-<ver>` from the start).
2. `downloadFile(directURL → mirrorURL, ~/.local/bin/cicy-code-<ver>)`.
3. `chmod 0o755`.
4. `--version` round-trip verifies the bytes; if mirror served stale, rename the file onto the real version.
5. `pkill -f ~/.local/bin/cicy-code` (and the previously stored `install_path` if it differs) kills the old daemon.
6. `ln -sfn cicy-code-<ver> ~/.local/bin/cicy-code` (written at a tmp name + renamed = atomic).
7. Re-spawn via the symlink (`spawn(linkPath, [], { detached: true })`).
8. `waitForHealth(/api/health)` up to 30 s; on success, `updateTeam(id, {install_path: linkPath})` so older team rows that stored a versioned path migrate to the symlink.

The cloud helper agent uses the **same layout** when it does the initial install (`AGENTS.md` step 1A.2/1A.3 in `cicy-cloud/workers/helper/`). It writes `cicy-code-<ver>` + `ln -sfn` + spawns via the symlink, then registers the team with `install_path=~/.local/bin/cicy-code`. This way the agent's install path and the desktop's upgrade path are identical — no special-case wiring needed.

### Sidecar cicy-code daemon

`cicy-desktop` never bundles a `cicy-code` binary. `src/sidecar/cicy-code.js::start()` acquires the daemon at runtime:

1. **Already running on `:8008`** — left over from a previous session, started by the user, or installed by the cloud Team Helper. `probeExisting()` detects it and `start()` reuses without re-spawning. This wins on every platform.
2. **mac / linux → `npx cicy-code`** — `start()` spawns `npx -y cicy-code` (default registry npmmirror for CN; override with `CICY_NPM_REGISTRY`, pin with `CICY_CODE_VERSION`). The launcher fetches the per-version binary from npm and does its own `:8008` port hygiene. No download/installer code in cicy-desktop.
3. **Windows → Docker** — `start()` delegates to `src/sidecar/docker.js` (`docker run` of the cicy-code image whose entrypoint `npx`-installs cicy-code). The image is loaded from R2 when absent.
4. **Cloud Team Helper** — the trial helper container walks the user through installing cicy-code on their machine, then registers the team via `window.cicy.localTeams.add({...})`.

**Retired (do not look for these):** the old in-app downloader `src/sidecar/installer.js` and the WSL path `src/sidecar/wsl.js` are **deleted**, along with their IPC handlers and the in-app install UI. There is no `bundledBinaryPath()`/`userBinary()`/`extraResources`/`vendor/cicy-code/` anymore. If no daemon is on `:8008` and the npx/Docker spawn can't run, `start()` returns `null` and the homepage's Team Helper card is the path from "no daemon" to "daemon running".

#### What broke that motivated the principle (2026-05-29)

Bundled `cicy-code` was pinned at `v2.1.2`. The trial helper installs `releases/latest` (now `v2.1.8`). On every cicy-desktop start the bundled `v2.1.2` raced ahead and bound `:8008`; when the helper later tried to launch `~/Downloads/cicy-code` it hit "address in use" and silently exited. Worse: `localTeams.list()` saw `:8008` healthy and added a "running" team card pointing at `w-6002`, which the `v2.1.2` daemon doesn't know how to spawn (the built-in pane only exists in `v2.1.8+`). End result: drawer swap → 404, version churn, hours wasted. The principle removes the bundled copy entirely — there's exactly one acquisition path and one source of truth at any time.

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
| sidecar acquisition (npx / docker) | `src/sidecar/cicy-code.js`, `src/sidecar/docker.js` |
| desktop shortcut + deep links (`cicy://`) | `bin/cicy-desktop` (shortcut gen), `src/main.js` (handleDeepLink) |
| local teams (add/upsert/rename) + i18n | `src/backends/local-teams.js`, `src/i18n/locales/*.json` |
| tool list module | `src/tools/index.js`, `src/tools/list-tools.js` |
| RPC test files | `tests/rpc/master-routes.test.js`, `tests/rpc/cicy-rpc.test.js` |

## Debugging via remote-debugging-port 9221

Electron renderers in dev are launched with `--remote-debugging-port=9221`. Use it instead of guessing.

```bash
# Open the tunnel once per session
ssh -fNR 9221:127.0.0.1:9221 mac        # if your dev → Mac
# or
ssh -fNL 9221:127.0.0.1:9221 mac        # if you're on Linux looking at Mac

# Enumerate targets (homepage + every <webview>)
curl -s http://127.0.0.1:9221/json/list | jq '.[] | {type, url, webSocketDebuggerUrl}'
```

Each target has a `webSocketDebuggerUrl`. Connect and send any `Runtime.evaluate` to inspect window state from outside Electron:

```js
// /tmp/cdp-probe.mjs
import http from 'node:http';
const targets = await new Promise(r =>
  http.get('http://127.0.0.1:9221/json/list', res => {
    let b=''; res.on('data',c=>b+=c); res.on('end',()=>r(JSON.parse(b)));
  }));
const target = targets.find(t => t.type === 'webview');   // or 'page' for homepage
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });

let id = 0;
function call(method, params={}) {
  const reqId = ++id;
  return new Promise(res => {
    ws.addEventListener('message', function h(e) {
      const m = JSON.parse(e.data);
      if (m.id === reqId) { ws.removeEventListener('message', h); res(m); }
    });
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
}

for (const expr of [
  'typeof window.electronRPC',
  'typeof window.cicy',
  'window.cicy && Object.keys(window.cicy.localTeams || {})',
  '(window.cicy && window.cicy.webviewPreloadPath) || null',
]) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(expr, '→', JSON.stringify(r.result?.result?.value));
}
ws.close();
```

Typical pattern after editing a preload: this probe **must** show your new field on the homepage target before you assume the change landed. If it shows the old surface, you forgot to `⌘+Q` + reopen Electron.

For the Team Helper webview specifically: its `webSocketDebuggerUrl` lives in the same `/json/list` output, typed `webview`. Probing it confirms whether the `<webview preload={file://...}>` attribute actually loaded `webview-preload.js`.

## Mental model checklist

When touching any of these, expect ripple effects:

- adding a tool → touches MCP server, REST/RPC, OpenAPI all at once via the catalog
- changing trust criteria → changes `nodeIntegration` for whole classes of windows; verify with the cicy-code bridge still works
- changing the homepage entry flow → check that cold-launch and "back to launcher" paths both behave (history.length / sessionStorage gates)
- changing the sidecar acquisition → there is no bundled binary; verify `npx cicy-code` (mac/linux) / Docker (win) actually spawns and binds `:8008`, and that `probeExisting` reuse still works
- changing `chrome_*` tools → both master injection (`effectiveChromeProfile`) and worker fallback (`~/cicy-ai/db/chrome.json`) paths still need to work
- changing **any preload file** → `⌘+Q` + reopen Electron is mandatory; HMR / `⌘+R` won't reload it. Confirm via CDP `Runtime.evaluate` on the target window
- changing **`src/backends/local-teams.js`** → it's `require`d by main; full Electron restart needed. Don't forget to also expose any new methods through both `homepage-preload.js` (full surface) and `webview-preload.js` (relay)
- changing the `<webview>` preload surface → also update `webview:relay` handlers in main + App.jsx so the new methods route correctly. Webview can't call IPCs directly; everything funnels through `webview:relay`
- changing the cloud Team Helper container → rebuild + restart copies a NEW `api_token`. Re-paste `HELPER_SHARED_TOKEN` in `workers/render/src/App.jsx` (HMRs) but if you also changed `HELPER_URL_BASE` you've effectively repointed the drawer — verify the new URL is reachable from the user's machine, not just yours
