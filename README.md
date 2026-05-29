# CiCy Desktop

CiCy Desktop is an Electron-based desktop automation worker with a small cluster control plane.

The project now has **two separate CLIs**:

- `cicy` / `cicy-desktop`: start, stop, inspect, and manage the local desktop/cluster lifecycle
- `cicy-rpc`: call worker RPC tools such as `ping`, `tools`, `open_window`, and `exec_js`

If you remember the old unified CLI model, that is no longer the current behavior.

## CLI split

### `cicy` / `cicy-desktop`
Use this for local desktop/cluster management only:

```bash
cicy start
cicy stop
cicy status
cicy restart
cicy logs
```

Equivalent alias:

```bash
cicy-desktop start
```

Notes:
- `npm start` runs the same desktop lifecycle entrypoint
- `cicy --json` / `cicy -j` is not supported
- RPC/tool commands moved to `cicy-rpc`

### `cicy-rpc`
Use this for RPC/tool calls only:

```bash
cicy-rpc init
cicy-rpc tools
cicy-rpc tools open_window
cicy-rpc ping
cicy-rpc open_window url=https://example.com
cicy-rpc --json get_window_info win_id=1
```

## Quick start

### 1. Install

```bash
git clone git@github.com:cicy-ai/cicy-desktop.git
cd cicy-desktop
npm install
```

### 2. Start the local desktop worker

```bash
cicy start
# or
npm start
```

### 3. Initialize RPC config

```bash
cicy-rpc init
```

This creates `~/global.json` if it does not exist.

### 4. Verify connectivity

```bash
cicy-rpc ping
```

### 5. Inspect available tools

```bash
cicy-rpc tools
cicy-rpc tools open_window
```

### 6. Open a page

```bash
cicy-rpc open_window url=https://example.com
```

## Homepage renderer (`workers/render`)

The cicy-desktop homepage UI lives in `workers/render` — a Vite + React app that
the Electron main process loads into the primary BrowserWindow.

### Where it's served from

- **Windows**: remote `https://desktop.cicy-ai.com` (CF Worker hosts the
  prod bundle; UI changes ship without rebuilding cicy-desktop).
- **Mac/Linux**: local `file:///.../src/backends/homepage-react/index.html`
  (a synced copy of `workers/render/dist/`, lets the homepage embed the
  HTTP team-assistant webview without mixed-content issues).
- **Dev**: set `CICY_HOMEPAGE_URL=http://localhost:8173` to load the live
  vite dev server instead. See "Dev workflow" below.

### Build → ship layout

```bash
# build the SPA
cd workers/render && npm run build
# copy into the file:// SPA folder cicy-desktop's main process loads from
rsync -av --delete dist/ ../../src/backends/homepage-react/
# deploy CF Worker (Windows users hit this URL)
npx wrangler deploy
```

### Dev workflow (Mac BrowserWindow → Vite dev server on Linux)

1. Start vite dev on this Linux box:
   ```bash
   cd workers/render && npm run dev   # serves on 0.0.0.0:8173
   ```
2. Tunnel the port to your Mac (so Mac's BrowserWindow can reach it):
   ```bash
   ssh -R 8173:127.0.0.1:8173 mac
   ```
3. On Mac, launch cicy-desktop with the dev URL env:
   ```bash
   CICY_HOMEPAGE_URL=http://localhost:8173 npm start
   ```
4. HMR works through Electron — edits in `workers/render/src/` hot-reload in the
   cicy-desktop window without rebuilding the .app.

`src/backends/homepage-window.js` selects URL like:
- `CICY_HOMEPAGE_URL` if set (dev or override)
- Windows → `https://desktop.cicy-ai.com`
- Mac/Linux → bundled `file://`

## Canonical config

`cicy-rpc` reads `~/global.json`.

Use this format:

```json
{
  "api_token": "your-default-token",
  "cicyDesktopNodes": {
    "local": {
      "api_token": "",
      "base_url": "http://localhost:8101"
    },
    "windows": {
      "api_token": "your-windows-token",
      "base_url": "http://windows-host:8101"
    }
  }
}
```

Rules:
- `cicyDesktopNodes.<name>.base_url` is the worker base URL
- `cicyDesktopNodes.<name>.api_token` overrides the top-level `api_token` for that node
- `CICY_NODE=<name>` selects the target node
- default node is `local`

Example:

```bash
CICY_NODE=windows cicy-rpc get_windows
```

## Main workflows

### Local lifecycle management

```bash
cicy start
cicy status
cicy logs
```

### Local tool calls

```bash
cicy-rpc ping
cicy-rpc tools
cicy-rpc open_window url=https://example.com
cicy-rpc get_window_info win_id=1
cicy-rpc --json get_window_info win_id=1
```

### Remote or multi-node tool calls

```bash
CICY_NODE=windows cicy-rpc ping
CICY_NODE=windows cicy-rpc get_windows
CICY_NODE=windows cicy-rpc open_window url=https://example.com
```

## What the worker can do

The worker exposes automation tools for:

- browser window lifecycle and navigation
- page interaction through CDP
- JavaScript execution inside pages
- screenshots, downloads, and clipboard operations
- system window control and system information
- worker/master cluster coordination

For the exact tool list, use:

```bash
cicy-rpc tools
```

## Architecture

Current source of truth in code:

- worker/server entry: `src/main.js:1`
- RPC CLI: `src/cli/rpc.js:1`
- desktop lifecycle CLI: `bin/cicy-desktop:1`
- tool implementations: `src/tools/*`

At a high level:
- `src/main.js:242` exposes `POST /rpc/tools/call`
- `src/main.js:267` exposes `GET /rpc/tools`
- `src/main.js:294` exposes `POST /rpc/:toolName`
- RPC routes are protected by auth and return `401 Unauthorized` when the token is wrong or missing
- the desktop CLI starts a local master + worker cluster and provides status/log management

## Authentication

RPC requests use the token loaded from `~/global.json`.

- CLI calls made through `cicy-rpc` send `Authorization: Bearer <token>`
- worker routes return `401 Unauthorized` if auth fails
- per-node token comes from `cicyDesktopNodes.<name>.api_token`, falling back to top-level `api_token`

## Troubleshooting

### `fetch failed`
Usually means the target node is unreachable.

Check:

```bash
cicy status
cicy-rpc ping
CICY_NODE=windows cicy-rpc ping
```

If needed, verify the node's `base_url` in `~/global.json`.

### `HTTP 401 Unauthorized`
Usually means the URL is correct but the token is wrong.

Check:
- `api_token`
- `cicyDesktopNodes.<name>.api_token`
- `cicyDesktopNodes.<name>.base_url`

Then retry:

```bash
cicy-rpc ping
```

### Window opened but page is not ready yet
Query the window state and wait for loading to finish:

```bash
cicy-rpc get_window_info win_id=1
```

For remote nodes:

```bash
CICY_NODE=windows cicy-rpc get_window_info win_id=1
```

## Documentation

Use the root README as the entrypoint, then go deeper here:

- [CLI split and usage](./skills/cicy-cli/README.md)
- [RPC CLI details](./packages/cicy-rpc/README.md)
- [REST API notes](./docs/REST-API.md)
- [Desktop service skill](./skills/cicy-desktop-service/README.md)

## License

MIT
