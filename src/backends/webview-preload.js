// Team Helper <webview> preload — runs inside the right-drawer webview that
// loads the cloud helper SPA. Exposes a deliberately TINY surface compared
// to homepage-preload.js: the helper agent is a remote third party, so it
// only gets a single "relay to the host renderer" channel.
//
// Flow for localTeams.add/remove/upgrade (matches user's design):
//
//   webview (helper agent exec-js)
//        │   ipcRenderer.invoke("webview:relay", {type, ...payload})
//        ▼
//   main process (just a router)
//        │   host.webContents.send("webview:relay", {reqId, msg})
//        ▼
//   homepage renderer (App.jsx) — registered onWebviewRelay handler
//        │   await window.cicy.localTeams.add(spec)  ← homepage's IPC
//        │   fetchLocalTeams()                        ← UI refresh
//        │   replyWebviewRelay(reqId, result)         ← back through main
//        ▼
//   main resolves the original invoke() with the renderer's result
//        ▼
//   webview gets the awaited promise

const { contextBridge, ipcRenderer } = require("electron");

const relay = (type, payload) =>
  ipcRenderer.invoke("webview:relay", { type, ...(payload || {}) });

// electronRPC is the generic tool dispatch the host preload exposes for the
// homepage — agent-desktop / agent-electron / agent-chrome skills (running
// inside the helper agent's exec-js calls) call window.electronRPC("exec_shell",
// {...}) etc. The Team Helper genuinely needs shell access to download +
// install cicy-code on the user's machine, so we mirror the same bridge
// here. Routed through the GUARDED channel ("rpc:guarded") — this is a remote
// third party, so dangerous tools (exec_*/file_*) prompt the user for a per-page
// grant before running (a trusted-origin XSS must not be silent RCE). Normal
// tools pass straight through. The homepage uses the unguarded "rpc" channel.
const electronRPC = (tool, args) => ipcRenderer.invoke("rpc:guarded", tool, args || {});

const cicyApi = {
  platform: process.platform,
  arch: process.arch,
  localTeams: {
    list:    ()             => relay("localTeams:list"),
    add:     (spec)         => relay("localTeams:add", { spec }),
    remove:  (id)           => relay("localTeams:remove", { id }),
    update:  (id, patch)    => relay("localTeams:update", { id, patch }),
    upgrade: (id)           => relay("localTeams:upgrade", { id }),
  },
  // (sidecar install/checkLatest removed — cicy-code is installed via
  // `npx cicy-code` by the sidecar, no in-app downloader.)
};

// contextBridge.exposeInMainWorld ONLY works with contextIsolation:true. createWindow
// runs TRUSTED urls with contextIsolation:false (+ nodeIntegration:true), where
// exposeInMainWorld throws — there the preload already shares the page's main-world
// `window`, so attach the bridge to it directly. Untrusted urls are isolated and
// must go through contextBridge. (process.contextIsolated tells us which world we're in.)
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("electronRPC", electronRPC);
  contextBridge.exposeInMainWorld("cicy", cicyApi);
} else {
  window.electronRPC = electronRPC;
  window.cicy = Object.assign(window.cicy || {}, cicyApi);
}

console.log(`[webview-preload] electronRPC + cicy.localTeams ready (isolated=${process.contextIsolated})`);
