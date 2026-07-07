# CiCy Desktop

CiCy Desktop is an Electron-based desktop automation worker with a small cluster
control plane. It exposes ~100+ system tools — Chrome/CDP control, in-page
JavaScript, screenshots, clipboard, file ops, shell/node/python exec, system
info — over MCP and HTTP, plus a homepage UI for managing local and remote
teams. The `cicy-code` sidecar daemon is acquired at runtime (`npx cicy-code` on
mac/linux, Docker-in-WSL on Windows), not bundled.

## CLI — `cicy` / `cicy-desktop`

Manage the local desktop/cluster lifecycle:

```bash
cicy start
cicy stop
cicy status
cicy restart
cicy logs
```

`cicy-desktop` is an alias for `cicy`; `npm start` runs the same entrypoint.

## Run (end users, no clone)

First run launches the Electron app and drops a desktop shortcut (Windows
`.lnk` / macOS `.app` / Linux `.desktop`, all with the CiCy icon); double-click
it afterwards.

**CN needs the electron mirror.** A fresh machine has no cached electron binary,
so electron's postinstall would otherwise hit GitHub releases and fail — point
`ELECTRON_MIRROR` and the npm registry at npmmirror.

### Windows — global install (not npx)

npx's libnpmexec lock false-positives as "Lock compromised" on Windows boxes
with realtime antivirus (Defender touches `node_modules` mtimes mid-install).
`npm i -g` has no such lock:

```cmd
cmd /c "set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/&& npm i -g cicy-desktop --registry=https://registry.npmmirror.com&& cicy-desktop"
```

Re-run the same line to update.

### macOS / Linux — npx

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm_config_registry=https://registry.npmmirror.com npx -y cicy-desktop
```

Outside CN (or once electron is cached) a plain `npx -y cicy-desktop` is enough.

## Develop

```bash
git clone git@github.com:cicy-ai/cicy-desktop.git
cd cicy-desktop
npm install
cicy start          # or: npm start
```

Config lives in `~/cicy-ai/global.json` (API token, gateway key, node list). The
worker reads its `Authorization: Bearer <token>` from there.

### Homepage UI (`workers/render`)

The desktop homepage — team cards, tabs, everything the user sees — is a Vite +
React app in `workers/render/`. The Electron main process loads a **prebuilt
snapshot** from `src/backends/homepage-react/` (a `file://` SPA: works offline,
no mixed-content issues embedding the team webview). Source and snapshot are two
different things — `scripts/build-homepage.cjs` (run on every `build:*` /
publish) rebuilds the snapshot so it never lags behind `workers/render/`.

Build → ship the snapshot:

```bash
cd workers/render && npm run build
rsync -av --delete dist/ ../../src/backends/homepage-react/
```

Fast dev loop (React/CSS HMR, no Electron restart): run Vite and source-mode
Electron with `CICY_HOMEPAGE_URL=http://localhost:8173` set (via `.env.dev`).
`src/backends/homepage-window.js` falls back to the bundled `file://` SPA if that
URL is unreachable, so the window never stays blank. Full platform/loop details
(Mac fast loop, Windows packaged, the three reload classes) are in the worker's
`CLAUDE.md`.

## Calling tools

The worker dispatches its tools three ways:

- **In-page (IPC):** `window.electronRPC(toolName, args)` — the bridge injected
  into trusted BrowserWindows.
- **HTTP (REST):** `POST /rpc/:toolName` with `Authorization: Bearer <token>` —
  served by the master, which forwards to the selected worker. `401
  Unauthorized` means the token is wrong or missing.
- **From an agent:** the `agent-desktop` / `agent-electron` / `agent-chrome`
  skills drive a connected client over WebSocket
  (`agent-desktop rpc <tool>`, `agent-desktop exec …`, etc.).

Discover tools at runtime:

- `list_tools` meta-tool (`electronRPC("list_tools")` / `agent-desktop rpc list_tools`)
- `GET /openapi.json` (browsable at `/docs`)

The worker exposes automation for: browser window lifecycle and navigation, CDP
page interaction, in-page JavaScript, screenshots / downloads / clipboard,
system window control and system info, and worker/master cluster coordination.

## Architecture

- worker/server entry — `src/main.js`
- desktop lifecycle CLI — `bin/cicy-desktop`
- tool implementations — `src/tools/*`
- master (routes `POST /rpc/:toolName` to workers) — `src/master/master-routes.js`
- homepage source — `workers/render/` → built into `src/backends/homepage-react/`

The **worker** dispatches tools in-process via `ipcMain.handle("rpc", …)` (what
`window.electronRPC` rides) and over HTTP; the live tool index is
`GET /openapi.json`. The desktop CLI starts a local master + worker cluster and
manages status/logs.

## License

[Apache-2.0](./LICENSE).
