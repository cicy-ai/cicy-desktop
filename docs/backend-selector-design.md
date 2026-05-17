# Backend Selector — Design

Status: **draft for review**. Source of truth for `src/backends/` and the
multi-window backend model. Adopted from the Genymotion shape: the desktop is
a launcher / shell; the real environments (local sidecar, cloud cicy-code
instances) live behind it as switchable backends.

## Vision

One installable `cicy-desktop`. After launch the user lands on a **Launcher**
window listing every backend they can reach:

- **Local** — bundled `cicy-code` daemon spawned by the sidecar (already
  wired). Always present, always single instance.
- **Cloud (catalog)** — instances the user owns on cicy-ai.com. Populated
  by the cloud catalog API once it exists. (Phase 2)
- **Manual** — arbitrary URL + token the user pasted in. Lives forever
  in the local registry until removed.

Each backend opens in its own `BrowserWindow`. Multiple windows can coexist
targeting different backends (one local + two cloud, etc.). Closing the last
local window keeps the sidecar running; quitting the app stops it.

## Phases

| Phase | Scope | Blockers |
|-------|-------|----------|
| **1** | Local sidecar + manual backends + multi-window + native HTML launcher | none |
| **2** | Cloud catalog: login to cicy-ai.com, pull "my instances", auto-add to registry | cicy-ai.com catalog endpoint must exist |
| **3** | Polish: per-window status pill, reconnect button, backend health monitor, drag-reorder | none, can be incremental |

## Phase 1 — detailed design

### Data model

```ts
type Backend = {
  id: string;             // uuid; "local" reserved for the sidecar entry
  name: string;           // user-visible label
  kind: "local" | "manual";  // Phase 2 adds "cloud"
  url: string;            // base URL (no token); for local = http://127.0.0.1:8008
  token?: string;         // bearer; absent for local (sidecar reads ~/global.json itself)
  addedAt: string;        // ISO timestamp
  lastUsedAt?: string;
};
```

Persistence: `<userData>/backends.json`, written atomically. Schema versioned
in a top-level `{ "version": 1, "backends": [...] }` envelope.

The `local` entry is **auto-upserted** on every startup so the user cannot
accidentally delete it; the Manage dialog hides the delete button for `local`.

### Modules

```
src/backends/
  registry.js       # BackendRegistry — file-backed CRUD + auto-upsert local
  window-manager.js # openWindowForBackend / closeAll / focus
  launcher.html     # native HTML launcher (no React)
  launcher.js       # launcher window's IPC + render logic (renderer-side)
  ipc.js            # main-side IPC handlers backends:list / add / remove / open
```

### Sidecar lifecycle changes (small)

`src/sidecar/cicy-code.js` already starts on `whenReady`. Phase 1 keeps that —
the sidecar starts unconditionally on app launch so the local backend is
"warm." When the catalog API ships (Phase 2) and the user wants to skip the
local sidecar entirely, we'll add `--no-sidecar` and a per-launcher toggle.

No multi-spawn risk: `sidecar.start()` already early-returns when `child` is
non-null or when `:8008` already has a listener.

### UI flows

**On launch.** No START_URL set → open launcher window (loads
`backends/launcher.html`). The launcher renders the registry list and
provides "Open", "+ Add backend", "Manage".

If a `--backend <id>` argv is present, skip the launcher and open that
backend directly. (Lets the existing `cicy-dektop.command` Desktop launcher
keep its "always open my default" behavior.)

**Open Window.** From launcher or menu → `backends.open(id)` IPC →
`window-manager.openWindowForBackend(backend)`:

- For `local`: await `sidecar.start()`, then `createWindow({ url: <sidecar URL with token from ~/global.json> })`. URL identical to the current single-window default.
- For `manual` / `cloud`: `createWindow({ url: \`${backend.url}/console/chrome?token=${backend.token}\` })`. Token is injected at the URL level; window has no other env coupling.

Each window gets a `Window.backendId` attached (via a `WeakMap` keyed on the
BrowserWindow). On close, the entry is removed.

**Add backend.** Form fields: name, URL, token. Validates URL parses, probes
`<url>/health` with the token, on success writes to registry + refreshes
list. No probe → still saves (offline edit).

**Manage.** Lists all non-`local` entries with delete button. Local entry
shown read-only at the top.

### IPC contract

```
backends:list      → Backend[]
backends:add       (input: {name, url, token, kind:"manual"})  → Backend
backends:remove    (id: string)  → boolean
backends:open      (id: string)  → {windowId: number}
backends:probe     ({url, token}) → {ok: bool, version?: string}
```

All registered in `src/backends/ipc.js`; exposed to the launcher renderer
via `contextBridge` in a small preload.

### Menu changes

```
File
  New Local Window           Cmd+N
  Open Backend Window…       Cmd+Shift+N    → launcher
  Manage Backends…
  ----
  Quit
```

### Sequence: app cold start with no argv

```
electronApp.whenReady
  ├─ ensureDesktopLauncher (existing)
  ├─ sidecarCicyCode.start (existing)
  ├─ server.listen 8101 (existing MCP)
  └─ openLauncherWindow()    ← new (replaces auto-createWindow(START_URL))
       └─ user clicks "Open" on a backend
           → windowManager.openWindowForBackend(backend)
               → BrowserWindow loading backend URL
```

Existing behavior preserved: if `START_URL` env / argv is set, skip launcher
and open it directly (keeps `node bin/cicy-desktop --url …` working).

## Phase 2 — cloud catalog (sketch only)

Once cicy-ai.com exposes:

```
GET https://cicy-ai.com/v1/instances   (auth: Bearer <user token>)
→ { instances: [ { id, name, url, token, region, ... } ] }
```

we add:

- `src/auth/cicy-ai.js` — OAuth or token-paste flow against cicy-ai.com,
  stores user token in `<userData>/cicy-ai-auth.json` (mode 0600).
- `BackendRegistry.refreshFromCloud()` — pulls /v1/instances, upserts
  entries with `kind: "cloud"`. Removes cloud entries that disappeared.
- Launcher gains a "Sign in to cicy-ai.com" button + "Refresh" action.

Cloud backends differ from manual only in:
- They can be re-fetched and updated automatically.
- Manage shows them read-only (server is the source of truth).

## Phase 3 — polish

- Window title bar shows backend name + green/red dot for health (200 on
  `<url>/health` within 5 s).
- "Reconnect" menu action for the active window.
- Background poller: every 30 s probe each backend with a listening window
  open; surface disconnects as a notification.
- Launcher: drag to reorder, search box, group by kind.

## Open questions

1. **Default backend on first launch.** Open launcher window, or auto-open
   the local backend (current behavior)? Lean toward launcher so the user
   sees their list immediately, but a "Open local by default" preference
   keeps the one-click path for power users.
2. **Sidecar autostart toggle.** When the user wants to use cloud-only and
   the local sidecar wastes resources. Adding `prefs.sidecarAutostart` is
   trivial; defer until someone asks.
3. **Per-backend window preferences.** Window position, zoom, devtools
   state — currently keyed on URL by `WindowState`. Re-keying on backendId
   would survive URL token rotation but is more code. Defer to Phase 3.
4. **Master/Worker cluster integration.** `src/master/` + `src/cluster/`
   currently treat the desktop as a worker registering to a master. That
   is **orthogonal** to backend selection; both can coexist. Worth
   re-evaluating in Phase 3 whether the cluster code is still needed at
   all once cloud catalog covers fleet view.

## Out of scope

- Auto-update / version-pin per backend.
- Backend-specific code-signing chains.
- Cross-machine session sync.
- Replacing the existing `src/master/` admin UI.

## Next concrete steps once approved

1. `src/backends/registry.js` + tests.
2. `src/backends/ipc.js` + `window-manager.js`.
3. `src/backends/launcher.html` + launcher renderer.
4. Wire menu items + initial-launch behavior into `src/main.js`.
5. Manual smoke: launch app → see launcher → open local → opens window →
   add a fake manual backend pointing at the same local URL → open second
   window → verify both windows render the chrome console independently.
