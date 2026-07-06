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

## Run (end users, no clone)

First run launches the Electron app and drops a desktop shortcut (Windows
`.lnk` / macOS `.app` / Linux `.desktop`, all with the CiCy icon); double-click
it afterwards.

**CN needs the electron mirror.** A fresh machine has no cached electron
binary, so electron's postinstall would hit GitHub releases and fail. Point
`ELECTRON_MIRROR` + the npm registry at npmmirror.

### Windows — global install (NOT npx)

npx's libnpmexec lock false-positives as `ECOMPROMISED` / "Lock compromised" on
Windows boxes with realtime antivirus (Defender touches `node_modules` mtimes
mid-install → the lock heartbeat aborts). `npm i -g` has no such lock, so
Windows installs globally and launches the global bin:

```cmd
cmd /c "set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/&& npm i -g cicy-desktop --registry=https://registry.npmmirror.com&& cicy-desktop"
```

Re-run the same line to update. The generated `.lnk` runs the global
`cicy-desktop` bin (no npx).

### macOS / Linux — npx

npx's lock works fine here:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm_config_registry=https://registry.npmmirror.com npx -y cicy-desktop
```

Outside CN (or once electron is cached) a plain `npx -y cicy-desktop` is enough.

## Quick start (development)

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

- **All platforms (Win/Mac/Linux)**: local
  `file:///.../src/backends/homepage-react/index.html` (a synced copy of
  `workers/render/dist/`). `pickHomepageURL()` returns this unconditionally —
  the bundled `file://` SPA works offline, is fast, and lets the homepage
  embed the HTTP team-assistant webview without mixed-content issues.
- **Dev**: set `CICY_HOMEPAGE_URL=http://localhost:8173` to load the live
  vite dev server instead. See "Dev workflow" below.

### Build → ship layout

```bash
# build the SPA
cd workers/render && npm run build
# copy into the file:// SPA folder cicy-desktop's main process loads from
rsync -av --delete dist/ ../../src/backends/homepage-react/
```

### Dev workflow

Vite runs **on Mac**. Source edits happen on Linux and are rsynced over —
Linux itself never serves the SPA. There used to be a Linux-runs-Vite +
`ssh -R` tunnel option; it was dropped because the tunnel silently dropped
mid-session and the resulting blank page wasted hours.

```bash
# On Linux: sync source to Mac
rsync -avz --delete \
  --exclude=node_modules --exclude=dist --exclude=.git \
  ~/projects/cicy-desktop/ mac:~/projects/cicy-desktop/

# On Mac: start Vite + run source-mode Electron
ssh mac
cd ~/projects/cicy-desktop/workers/render
npm install               # first time only
npm run dev               # serves http://localhost:8173

# In another shell on Mac
cd ~/projects/cicy-desktop
pkill -f "MacOS/CiCy Desktop" 2>/dev/null   # stop any installed .app first
bash -c 'set -a; . ./.env.dev; set +a; npm start'
# .env.dev sets CICY_HOMEPAGE_URL=http://localhost:8173 so Electron loads
# the Vite bundle (HMR enabled) instead of the bundled file:// one.
```

Now edit `workers/render/src/App.jsx` on Linux → `rsync` to Mac →
Vite HMR picks it up instantly. No Electron restart for React/CSS edits.

> **Fallback**: if `CICY_HOMEPAGE_URL` is set but unreachable (Vite not
> started, port conflict), `homepage-window.js` falls back to the bundled
> `file://` SPA so the window never stays blank.

`src/backends/homepage-window.js` URL priority:
1. `CICY_HOMEPAGE_URL` env (dev override) → falls back to `file://` on load failure
2. All platforms → bundled `file://src/backends/homepage-react/index.html`

### Shipping SPA changes to Windows (hotpatch)

Windows loads the same local `file://` SPA as Mac/Linux — the running
npm-global install reads `src/backends/homepage-react/`. So shipping a SPA
change = sync the files, **not** redeploy a Worker (there is no remote
homepage Worker for Windows anymore):

```bash
# build + mirror into the file:// folder
cd workers/render && npm run build
rsync -av --delete dist/ ../../src/backends/homepage-react/
# package backend + SPA and push to the Windows box
cd ../.. && tar czf /tmp/cicy-hotpatch.tgz src build bin package.json
scp /tmp/cicy-hotpatch.tgz win:'C:/Users/Administrator/cicy-hotpatch.tgz'
ssh win 'cd /d "C:\Users\Administrator\AppData\Roaming\npm\node_modules\cicy-desktop" && tar -xzf C:\Users\Administrator\cicy-hotpatch.tgz'
# relaunch in the *interactive* session (session 0 can't paint a GUI window)
ssh win 'schtasks /run /tn StartElectron'
```

The `StartElectron` scheduled task is set to "interactive only" so the
relaunched window appears on the user's RDP desktop. `bin/cicy-desktop`
always opens `--remote-debugging-port=9221`, so verify the reload over CDP.

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
- the **worker** dispatches tools two ways: in-process via `ipcMain.handle("rpc", …)` (`src/main.js`, what `window.electronRPC(tool, args)` rides) and over HTTP. The full, live tool index is `GET /openapi.json` (browse at `/docs`); call `list_tools` to enumerate from the RPC/IPC side.
- REST tool invocation (`POST /rpc/:toolName`, used by `cicy-rpc`) is served by the **master** (`src/master/master-routes.js`), which forwards to the selected worker.
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

Apache-2.0
