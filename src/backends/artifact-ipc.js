// artifact-ipc.js — main-process side of the window.cicy.artifact bridge.
//
// The cicy-code app (loaded in a trusted team BrowserWindow) hosts a
// <webview id="cicy-artifact-webview"> for the 产物 (artifact) tab. Its
// renderer bridge (cicy-code app/src/lib/artifactBridge.ts) drives that
// webview's *guest* webContents through `window.cicy.artifact.{invoke,cdp}` —
// injected in window-utils.js — which round-trips to the handlers here.
//
// We resolve the guest via webContents.fromId(guestId) (the renderer passes the
// element's getWebContentsId()), call webContents methods / drive its debugger,
// and forward the guest's console / navigation / CDP-message events back to the
// host renderer as 'artifact:event' (re-dispatched there as the
// CustomEvent('cicy-artifact-event') the bridge buffers).

const { ipcMain, webContents } = require("electron");
const log = require("electron-log");

// guest webContents.id → host renderer webContents that should receive events.
// Updated on every invoke/attach so events follow host reloads.
const guestHost = new Map();
// guest webContents.id we've already wired passive (console/nav) listeners on.
const wiredPassive = new Set();
// guest webContents.id we've already wired the debugger 'message'/'detach' on.
const wiredDebugger = new Set();

function getGuest(guestId) {
  const wc = typeof guestId === "number" ? webContents.fromId(guestId) : null;
  if (!wc || wc.isDestroyed()) {
    throw new Error(`artifact guest webContents ${guestId} not found (open the 产物 tab once)`);
  }
  return wc;
}

function emit(wc, detail) {
  try {
    const host = guestHost.get(wc.id);
    if (host && !host.isDestroyed()) host.send("artifact:event", detail);
  } catch {}
}

function rememberHost(wc, hostSender) {
  guestHost.set(wc.id, hostSender);
  if (!wc.__artifactCleanup) {
    wc.__artifactCleanup = true;
    wc.once("destroyed", () => {
      guestHost.delete(wc.id);
      wiredPassive.delete(wc.id);
      wiredDebugger.delete(wc.id);
    });
  }
}

// console-message + navigation → host renderer. Wired once per guest.
function wirePassive(wc) {
  if (wiredPassive.has(wc.id)) return;
  wiredPassive.add(wc.id);
  wc.on("console-message", (_e, level, message, line, sourceId) => {
    emit(wc, { source: "console", level, message, line, sourceId });
  });
  wc.on("did-navigate", (_e, url, httpResponseCode) => {
    emit(wc, { source: "navigation", kind: "did-navigate", url, httpResponseCode });
  });
  wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
    emit(wc, { source: "navigation", kind: "did-navigate-in-page", url, isMainFrame });
  });
}

// debugger 'message' (the CDP event stream) + 'detach' → host renderer. Wired
// once per guest; survives attach/detach cycles (only fires while attached).
function wireDebugger(wc) {
  if (wiredDebugger.has(wc.id)) return;
  wiredDebugger.add(wc.id);
  wc.debugger.on("message", (_e, method, params) => {
    emit(wc, { source: "cdp", method, params });
  });
  wc.debugger.on("detach", (_e, reason) => {
    emit(wc, { source: "cdp", method: "__detached", params: { reason } });
  });
}

function register() {
  // Call any webContents method on the artifact guest. capturePage/printToPDF
  // are normalized to dataURL / base64 so the result survives JSON/WS.
  ipcMain.handle("artifact:invoke", async (e, payload) => {
    const { guestId, method, args = [] } = payload || {};
    const wc = getGuest(guestId);
    rememberHost(wc, e.sender);
    wirePassive(wc);
    if (typeof wc[method] !== "function") {
      throw new Error(`artifact.invoke: webContents has no method '${method}'`);
    }
    if (method === "capturePage") {
      const img = await wc.capturePage(...(args || []));
      return img && typeof img.toDataURL === "function" ? img.toDataURL() : null;
    }
    if (method === "printToPDF") {
      const buf = await wc.printToPDF((args && args[0]) || {});
      return Buffer.from(buf).toString("base64");
    }
    return await wc[method](...(args || []));
  });

  ipcMain.handle("artifact:cdp-attach", async (e, payload) => {
    const { guestId, protocolVersion } = payload || {};
    const wc = getGuest(guestId);
    rememberHost(wc, e.sender);
    // DevTools and the debugger are mutually exclusive on one webContents —
    // close a manually-opened inspector first, else attach() throws.
    try { if (wc.isDevToolsOpened()) wc.closeDevTools(); } catch {}
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach(protocolVersion || "1.3");
    }
    wireDebugger(wc);
    wirePassive(wc);
    return { ok: true, attached: true };
  });

  ipcMain.handle("artifact:cdp-detach", async (_e, payload) => {
    const { guestId } = payload || {};
    const wc = getGuest(guestId);
    if (wc.debugger.isAttached()) wc.debugger.detach();
    return { ok: true, attached: false };
  });

  ipcMain.handle("artifact:cdp-is-attached", async (_e, payload) => {
    const { guestId } = payload || {};
    try { return getGuest(guestId).debugger.isAttached(); } catch { return false; }
  });

  ipcMain.handle("artifact:cdp-send", async (_e, payload) => {
    const { guestId, method, params } = payload || {};
    const wc = getGuest(guestId);
    if (!wc.debugger.isAttached()) {
      throw new Error("artifact.cdp: debugger not attached (call cdp.attach first)");
    }
    return await wc.debugger.sendCommand(method, params || {});
  });

  log.info("[artifact] window.cicy.artifact IPC handlers registered");
}

module.exports = { register };
