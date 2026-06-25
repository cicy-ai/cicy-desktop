const { app: electronApp } = require("electron");
const { default: contextMenu } = require("electron-context-menu");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cicyCodeSidecar = require("./sidecar/cicy-code");
const backendsIPC = require("./backends/ipc");
const { openHomepage } = require("./backends/homepage-window");
const backendsRegistry = require("./backends/registry");
const { openWindowForBackend } = require("./backends/window-manager");
const { Menu } = require("electron");
const { dialog } = require("electron");
const { setupAppIcons } = require("./tray");
const { brandHostElectron } = require("./utils/brand-host-electron");
const appUpdater = require("./app-updater");

// 🎯 Right-click menu — attach the SAME menu to EVERY webContents (host window,
// tab, <webview>, popup) via 'web-contents-created'. ecm only auto-attaches to a
// BrowserWindow's MAIN webContents, so the tab-browser SHELL window ("BaseWindow")
// and guests fell back to the OS-native menu; this unifies them and adds 重新加载
// + 切换开发者工具 + 检查元素 everywhere (see utils/context-menu-options.js).
const { attachContextMenu } = require("./utils/context-menu-options");
electronApp.on("web-contents-created", (_e, wc) => {
  attachContextMenu(wc);
  // Ctrl/Cmd+C inside a <webview> guest: on Windows the application menu's
  // role:"copy" accelerator doesn't reach the focused guest, so a selection
  // couldn't be copied with the keyboard (right-click 复制 is fixed separately via
  // attachContextMenu). Wire copy directly on the guest. COPY-ONLY and WITHOUT
  // preventDefault, so the gotty terminal's Ctrl+C=SIGINT and any web app's own
  // copy handler still fire; wc.copy() is a no-op when there's no selection.
  try {
    if (wc.getType && wc.getType() === "webview") {
      wc.on("before-input-event", (_ev, input) => {
        if (input.type === "keyDown" && (input.control || input.meta) &&
            !input.alt && !input.shift && (input.key === "c" || input.key === "C")) {
          try { wc.copy(); } catch (_) {}
        }
      });
    }
  } catch (_) {}
});

// Setup Electron flags IMMEDIATELY after require
electronApp.commandLine.appendSwitch("ignore-certificate-errors");
// Allow CDP WebSocket connections from any origin so we can drive Page.reload
// remotely (HMR-fallback when CSS / a renderer-side change needs a hard refresh).
// Without this Electron rejects CDP WS handshakes with HTTP 403.
electronApp.commandLine.appendSwitch("remote-allow-origins", "*");
if (process.platform === "linux") {
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
  // electronApp.commandLine.appendSwitch("disable-setuid-sandbox");
  electronApp.commandLine.appendSwitch("log-level", "3");
  electronApp.commandLine.appendSwitch("disable-notifications");
  electronApp.commandLine.appendSwitch("ignore-certificate-errors");
  if (process.env.ELECTRON_DISABLE_HTTP_CACHE === "1") {
    electronApp.commandLine.appendSwitch("disable-http-cache");
    electronApp.commandLine.appendSwitch("disable-application-cache");
  }
  electronApp.commandLine.appendSwitch("disable-geolocation");
  electronApp.commandLine.appendSwitch("disable-dev-shm-usage");
  electronApp.commandLine.appendSwitch("use-gl", "angle");
  electronApp.commandLine.appendSwitch("use-angle", "swiftshader");
}

const http = require("http");
const log = require("electron-log");
const { config } = require("./config");
const { createWindow } = require("./utils/window-utils");
const { AuthManager } = require("./utils/auth");
const { setupElectronFlags, setupErrorHandlers } = require("./server/electron-setup");
const { parseArgs } = require("./server/args-parser");
const { setupLogging, wrapLogger } = require("./server/logging");
const { createExpressApp } = require("./server/express-app");
const { createWorkerObservabilityRoutes } = require("./server/worker-observability-routes");
const { createChromeProxyRoutes } = require("./server/chrome-proxy-routes");
const { createChromeManagementRoutes } = require("./server/chrome-management-routes");
const { createMcpServer, setupMcpRoutes } = require("./server/mcp-server");
const { registerTool } = require("./server/tool-registry");
const { loadToolCatalog } = require("./server/tool-catalog");
const { executeTool } = require("./server/tool-executor");
const { getWorkerIdentity } = require("./cluster/worker-identity");
const { listLocalAgents } = require("./cluster/local-agent-registry");
const { WorkerClient } = require("./cluster/worker-client");
const { getChromeRuntimeRegistry } = require("./chrome/runtime-registry");

// Setup
// setupElectronFlags(); // Already done above
setupErrorHandlers();

// i18n: initialize as early as possible so menus / tray / dialogs use the
// detected locale. app.getLocale() works after Electron is ready, but for the
// initial label fallback we use process.env.LANG so the first burst of
// console output / tray template still falls back to English when locale
// detection fails.
const i18n = require("./i18n");
const __initialLocale = (() => {
  try { return electronApp.getLocale ? electronApp.getLocale() : (process.env.LANG || ""); }
  catch { return process.env.LANG || ""; }
})();
i18n.init(__initialLocale);

// Synchronous bridge so the homepage preload — which runs in the RENDERER
// process and therefore holds its OWN separate i18n module instance — can
// resolve the same locale the main process picked. Without this the preload's
// lazy init() falls back to English regardless of OS language, so
// window.cicyI18n.t() returned English even on zh-CN systems. Read live at call
// time, so it reflects the ready-time changeLanguage() below.
try {
  require("electron").ipcMain.on("i18n:locale", (e) => {
    e.returnValue = (i18n.i18next && i18n.i18next.language) || i18n.FALLBACK || "en";
  });
} catch {}

// Single-instance lock: only one cicy-desktop process can hold the primary
// instance. A second launch sends `second-instance` with argv to the primary
// and exits itself. The primary focuses its homepage so the user sees the
// running app instead of nothing happening.
const __singleLock = electronApp.requestSingleInstanceLock();
if (!__singleLock) {
  electronApp.exit(0);
}

// Windows groups taskbar buttons + picks the taskbar icon by AppUserModelId.
// Unpackaged (npx / npm i -g) there's no installer to register one, so without
// this the taskbar shows the stock Electron icon even when each BrowserWindow
// sets its own. Must be set before any window is created. (No-op off Windows.)
if (process.platform === "win32") {
  try { electronApp.setAppUserModelId("com.cicy.desktop"); } catch {}
}

// Register cicy-desktop:// as the desktop's URL protocol. We MOVED off the bare
// `cicy://` scheme because it collides: the CiCy mobile/Expo app (com.cicy-ai
// .mobile) and a generic com.github.Electron both claim `cicy:`, so a browser
// click routes the deeplink to the wrong app (the desktop only got it when an
// already-running Electron instance happened to intercept its own scheme).
// `cicy-desktop://` is desktop-only → browsers route it unambiguously here.
// `cicy://` stays registered + accepted for back-compat with old links.
// On macOS the OS calls open-url; on Windows/Linux the URL arrives in argv
// (second-instance below, or process.argv on cold start).
const DEEPLINK_SCHEMES = ["cicy-desktop", "cicy"]; // primary, then legacy
const isDeepLink = (u) =>
  typeof u === "string" && DEEPLINK_SCHEMES.some((s) => u.startsWith(`${s}://`));
for (const s of DEEPLINK_SCHEMES) {
  try { if (!electronApp.isDefaultProtocolClient(s)) electronApp.setAsDefaultProtocolClient(s); } catch {}
}

// Deep links can arrive before any BrowserWindow exists (cold start via
// `cicy://` on macOS fires `open-url` before whenReady; same for Windows/
// Linux when the URL is in argv). Queue them and flush whenever a window
// finishes loading. The renderer subscribes via window.cicy.deeplink.onAddTeam.
const __pendingDeepLinks = [];
// Deep-link delivery targets = every BrowserWindow's webContents PLUS the
// homepage tab's webContents. The homepage is now a BrowserView tab (not a
// BrowserWindow), so getAllWindows() alone would miss it and cicy://addTeam
// would only refresh on the next poll instead of instantly.
function deepLinkTargets() {
  const { BrowserWindow } = require("electron");
  const targets = BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .map((w) => w.webContents);
  try {
    const hw = require("./backends/homepage-window").getHomepageWindow();
    const wc = hw && hw.webContents;
    if (wc && !wc.isDestroyed() && !targets.includes(wc)) targets.push(wc);
  } catch {}
  return targets;
}
function broadcastDeepLink(channel, payload) {
  const targets = deepLinkTargets();
  if (targets.length === 0) {
    __pendingDeepLinks.push({ channel, payload });
    return;
  }
  for (const wc of targets) {
    try { wc.send(channel, payload); } catch {}
  }
}

// Replays any queued deep links to all currently-loaded renderers. Wired up
// to `did-finish-load` on the homepage window so the SPA always sees them
// even when it was the URL that started the app in the first place.
function flushPendingDeepLinks() {
  if (__pendingDeepLinks.length === 0) return;
  const targets = deepLinkTargets();
  if (targets.length === 0) return;
  const drained = __pendingDeepLinks.splice(0, __pendingDeepLinks.length);
  for (const { channel, payload } of drained) {
    for (const wc of targets) {
      try { wc.send(channel, payload); } catch {}
    }
  }
}
electronApp.on("browser-window-created", (_e, win) => {
  win.webContents.on("did-finish-load", () => {
    setTimeout(flushPendingDeepLinks, 0);
  });
});

async function handleDeepLink(url) {
  log.info(`[deeplink] handleDeepLink got: ${url}`);
  if (!isDeepLink(url)) return;
  try {
    // cicy-desktop://addTeam?title=My+Team&url=https://...&token=xxx
    // (legacy cicy://addTeam?... still accepted)
    const u = new URL(url);
    const action = (u.hostname || "").toLowerCase();
    if (action === "addteam") {
      const payload = {
        title: u.searchParams.get("title") || "",
        url:   u.searchParams.get("url")   || "",
        token: u.searchParams.get("token") || "",
      };
      // Add the team HERE in the main process — robust and independent of
      // whether a renderer is loaded/listening. (The renderer never wired up
      // window.cicy.deeplink.onAddTeam, so the old broadcast-only path silently
      // dropped the team.) local-teams.addTeam upserts by base_url; the
      // homepage polls localTeams:list every few seconds so the new team shows
      // up on its own. We still broadcast for an instant refresh.
      if (payload.url) {
        try {
          const lt = require("./backends/local-teams");
          const r = await lt.addTeam({
            base_url: payload.url,
            api_token: payload.token || undefined,
            name: payload.title || undefined,
          });
          log.info(`[deeplink] addTeam result: ${JSON.stringify(r)}`);
        } catch (e) {
          log.warn(`[deeplink] addTeam failed: ${e.message}`);
        }
      }
      broadcastDeepLink("deeplink:addTeam", payload);
      // Make sure SOMETHING is on screen for the user to see the result.
      // Safe to call before whenReady — openHomepage waits for the app
      // internally via BrowserWindow construction.
      if (electronApp.isReady()) {
        try {
          const { openHomepage } = require("./backends/homepage-window");
          openHomepage();
        } catch {}
      }
    }
  } catch (e) { log.warn(`[deeplink] parse error: ${e.message}`); }
}

// macOS: fired when app is already running OR cold-launched via cicy:// URL.
electronApp.on("open-url", (_e, url) => {
  log.info(`[deeplink] open-url event fired url=${url}`);
  _e.preventDefault();
  handleDeepLink(url);
});

// Cold start on Windows/Linux: protocol URL is the last argv element. macOS
// also gets the argv copy on some launchers, so this is harmless there.
{
  const coldUrl = process.argv.find(a => isDeepLink(a));
  if (coldUrl) handleDeepLink(coldUrl);
}

electronApp.on("second-instance", (_e, argv) => {
  // argv may include a cicy-desktop:// (or legacy cicy://) URL on Windows/Linux
  const cicyUrl = argv.find(a => isDeepLink(a));
  if (cicyUrl) handleDeepLink(cicyUrl);

  try {
    const { openHomepage } = require("./backends/homepage-window");
    openHomepage();
  } catch {}
  const { BrowserWindow } = require("electron");
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
});

// Parse arguments
const {
  PORT,
  START_URL,
  PROXY,
  oneWindow,
  enableMcp,
  ACCOUNT,
  chromeBinary,
  chromeUserDataRoot,
  chromeDebuggerBasePort,
} = parseArgs();

// The two remote-control surfaces are the HTTP/MCP tool server (PORT, default
// 8101) and the Chrome DevTools Protocol debug port (9221). CDP has NO
// authentication — anyone who can reach 9221 can drive every Electron window
// (run arbitrary JS, read the DOM, navigate). So gate BOTH behind the same
// opt-in: a default desktop install (no --mcp, no CICY_DESKTOP_HTTP, no
// CICY_MASTER_URL) opens neither, removing the unauthenticated CDP surface
// entirely unless automation is actually wanted.
const automationEnabled =
  process.env.CICY_DESKTOP_HTTP === "1" || enableMcp || !!process.env.CICY_MASTER_URL;

// CDP 调试口(9221)默认开(主人令),只绑 127.0.0.1 回环、不暴露到网络。与上面的
// HTTP/MCP server 解耦:HTTP server 仍按 automationEnabled 控制(避免对外 0.0.0.0
// 暴露 / 防火墙弹窗),CDP 单独默认开。要关 CDP:显式设 CICY_DESKTOP_CDP=0。
const cdpEnabled = process.env.CICY_DESKTOP_CDP !== "0";

config.port = PORT;
if (chromeBinary) {
  config.chromeBinary = chromeBinary;
}
if (chromeUserDataRoot) {
  config.chromeUserDataRoot = chromeUserDataRoot;
}
if (chromeDebuggerBasePort) {
  config.chromeDebuggerBasePort = chromeDebuggerBasePort;
}
if (PROXY) {
  config.proxy = PROXY;
  log.info(`[MCP] Global proxy enabled: ${PROXY}`);
}
if (oneWindow) {
  config.oneWindow = true;
  log.info("[MCP] Single window mode enabled");
}

// Setup logging
setupLogging(config);
wrapLogger();

log.info("[MCP] Server starting at", new Date().toISOString());

// Initialize auth
const authManager = new AuthManager();
global.authManager = authManager; // Make it globally accessible
const authMiddleware = (req, res, next) => {
  if (!authManager.validateAuth(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="CiCy Desktop"');
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// Create servers
const mcpServer = createMcpServer();
const toolCatalog = loadToolCatalog();
const tools = {};
const app = createExpressApp(authMiddleware, tools);

// Register tools
Array.from(toolCatalog.toolsByName.values()).forEach((tool) => {
  registerTool(
    mcpServer,
    tools,
    tool.name,
    tool.description,
    tool.schema,
    tool.handler,
    tool.options
  );
});

// Setup MCP routes (only when --mcp flag is passed)
if (enableMcp) {
  setupMcpRoutes(app, mcpServer, authMiddleware);
  log.info("[MCP] MCP routes enabled");
}

function parseYamlBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        const yaml = require("js-yaml");
        resolve(yaml.load(data) || {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function buildRequestContext(req, extra = {}) {
  return {
    transport: extra.transport || "rest",
    requestId: req.headers["x-request-id"] || null,
    controlSessionId:
      req.headers["x-session-id"] || req.query.sessionId || req.body?.sessionId || null,
    agentId: req.headers["x-agent-id"] || req.query.agentId || req.body?.agentId || null,
    runtimeSessionId:
      req.headers["x-runtime-session-id"] ||
      req.query.runtimeSessionId ||
      req.body?.runtimeSessionId ||
      null,
    windowRef: req.body?.windowRef || null,
    accountIdx: req.body?.accountIdx,
    worker: getWorkerIdentity(),
    ...extra,
  };
}

function sendToolResponse(req, res, result) {
  const accept = req.headers.accept || "application/json";
  if (accept.includes("application/yaml") || accept.includes("text/yaml")) {
    const yaml = require("js-yaml");
    res.type("yaml").send(yaml.dump({ result }));
  } else {
    res.json({ result });
  }
}

function sendExecutionError(res, error) {
  if (error.name === "ZodError") {
    const errorMsg = error.errors.map((e) => e.message).join(", ");
    return res.json({
      result: {
        content: [{ type: "text", text: errorMsg }],
        isError: true,
      },
    });
  }

  res.status(500).json({ error: error.message });
}

function getWorkerSnapshot(authManager) {
  const chromeRuntimeRegistry = getChromeRuntimeRegistry();
  return {
    baseUrl: `http://127.0.0.1:${config.port}`,
    authToken: authManager.getToken(),
    capabilities: Object.values(tools)
      .flat()
      .map((tool) => tool.name),
    agents: listLocalAgents(),
    chromeProfiles: chromeRuntimeRegistry.list(),
    resources: {
      pid: process.pid,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
    },
  };
}

app.use(
  "/observability",
  createWorkerObservabilityRoutes({
    getWorkerIdentity,
    getWorkerSnapshot: () => getWorkerSnapshot(authManager),
  })
);

// Chrome profile debugger HTTP facade (no websocket proxy in v1)
app.use(
  "/chrome",
  authMiddleware,
  createChromeProxyRoutes({
    registry: getChromeRuntimeRegistry(),
  })
);

function maybeCreateWorkerClient(authManager) {
  const masterUrl = process.env.CICY_MASTER_URL;
  const workerToken = process.env.CICY_MASTER_TOKEN;
  if (!masterUrl || !workerToken) return null;

  return new WorkerClient({
    masterUrl,
    workerToken,
    workerIdentity: getWorkerIdentity(),
    getStatusSnapshot: () => getWorkerSnapshot(authManager),
  });
}

app.get("/api/worker", authMiddleware, (req, res) => {
  res.json({ worker: getWorkerIdentity() });
});

app.get("/api/agents", authMiddleware, (req, res) => {
  res.json({ agents: listLocalAgents() });
});

app.use(
  "/api/chrome",
  createChromeManagementRoutes({
    authMiddleware,
    executeTool,
    buildRequestContext,
  })
);

// HTTP RPC routes (only when --http-rpc flag is passed)

// Start server
const server = http.createServer(app);

// 必须在 whenReady 之前设置调试端口。CDP 无鉴权,仅在自动化启用时才开,并显式
// 绑回环地址(默认已是 127.0.0.1,显式设置防止意外暴露到 0.0.0.0)。
if (cdpEnabled) {
  electronApp.commandLine.appendSwitch("remote-debugging-port", "9221");
  electronApp.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  log.info("[MCP] Remote debugging enabled on 127.0.0.1:9221 (default on; set CICY_DESKTOP_CDP=0 to disable)");
} else {
  log.info("[MCP] Remote debugging port NOT opened (CICY_DESKTOP_CDP=0)");
}

// Register the cicy:// scheme (tab-browser start page) — must run before ready.
require("./tabbrowser/newtab-protocol").registerScheme();

// IPC Bridge: expose all RPC tools to renderer via ipcMain.handle
const { ipcMain } = require("electron");
const { isDangerousTool, ensureRpcGrant, ensureOriginAuthorized, originDecision, startOriginModal } = require("./utils/rpc-guard");
// Sentinels returned (as normal tool results, so useDesktopEvents forwards their
// text verbatim) to a NON-BLOCKING caller while origin consent is undecided/denied.
// The agent/skill CLI polls on __CICY_AUTH_PENDING__ and stops on __CICY_AUTH_DENIED__.
const AUTH_PENDING_RESULT = { content: [{ type: "text", text: "__CICY_AUTH_PENDING__" }], isError: false };
const AUTH_DENIED_RESULT = { content: [{ type: "text", text: "__CICY_AUTH_DENIED__" }], isError: false };
const { audit, argsPreview } = require("./utils/rpc-audit");
function rpcOrigin(event) {
  try { return new URL(event.sender.getURL()).origin; } catch { return (event && event.sender && event.sender.getURL && event.sender.getURL()) || "(unknown)"; }
}
async function dispatchRpc(event, toolName, args) {
  const result = await executeTool(toolName, args || {}, {
    transport: "ipc",
    toolName,
    controlSessionId: args?.controlSessionId || null,
    agentId: args?.agentId || null,
    runtimeSessionId: args?.runtimeSessionId || null,
    windowRef: args?.windowRef || null,
    accountIdx: args?.accountIdx,
    worker: getWorkerIdentity(),
    webContentsId: event.sender.id,
  });
  return result;
}
// "rpc" — unguarded full bridge for the first-party homepage system UI only.
ipcMain.handle("rpc", async (event, toolName, args) => {
  console.log("[IPC Bridge] called:", toolName, JSON.stringify(args));
  const origin = rpcOrigin(event);
  const danger = isDangerousTool(toolName);
  try {
    const result = await dispatchRpc(event, toolName, args);
    console.log("[IPC Bridge] success:", toolName);
    audit({ kind: "rpc", channel: "rpc", origin, tool: toolName, dangerous: danger, ok: true, args: argsPreview(toolName, args) });
    return result;
  } catch (e) {
    console.error("[IPC Bridge] error:", toolName, e.message);
    audit({ kind: "rpc", channel: "rpc", origin, tool: toolName, dangerous: danger, ok: false, error: e.message, args: argsPreview(toolName, args) });
    throw e;
  }
});
// FIFO concurrency limiter for the guarded path. While the consent modal is open
// a page (or the cloud rpc_call bridge) can pile up many RPC calls all awaiting
// the same authorization promise; the moment the user clicks 允许 they would ALL
// resolve and dispatch in one microtask flush, pegging the main thread for a beat
// ("点完之后卡一阵"). The limiter spreads that burst over a few in-flight slots —
// a single call still runs immediately (slot is free), only true bursts queue.
function makeLimiter(max) {
  let active = 0;
  const q = [];
  const pump = () => {
    while (active < max && q.length) {
      active++;
      const { fn, resolve, reject } = q.shift();
      Promise.resolve().then(fn).then(
        (v) => { active--; resolve(v); pump(); },
        (e) => { active--; reject(e); pump(); },
      );
    }
  };
  return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); pump(); });
}
const guardedDispatchLimit = makeLimiter(6);

// "rpc:guarded" — for every non-homepage renderer (team-helper webview, trusted
// remote pages, injected scripts). Dangerous tools (exec_*/file_*) require an
// explicit per-page user grant so a trusted-origin XSS can't silently run code.
ipcMain.handle("rpc:guarded", async (event, toolName, args) => {
  console.log("[IPC Bridge] guarded call:", toolName);
  // Domain-allowlist gate: a non-allowlisted origin must be authorized via a
  // consent modal (deny / allow once / add to allowlist) before it can use the
  // bridge at all. Allowlisted origins pass straight through.
  const origin = rpcOrigin(event);
  const danger = isDangerousTool(toolName);
  // Agent/skill calls tag args with __cicyAuthNonBlocking: their transport is one
  // fixed-timeout HTTP request, so they can't sit on the blocking consent modal.
  // For an undecided origin we pop the modal in the BACKGROUND and hand back a
  // PENDING sentinel the caller polls on; a denied origin gets a DENIED sentinel.
  // In-page callers (no tag) keep the original blocking behaviour.
  let nonBlockingAuth = false;
  if (args && typeof args === "object" && args.__cicyAuthNonBlocking) {
    nonBlockingAuth = true;
    args = { ...args };
    delete args.__cicyAuthNonBlocking;
  }
  if (nonBlockingAuth) {
    const decision = originDecision(event); // "allow" | "deny" | "unknown" (no prompt)
    if (decision === "deny") {
      audit({ kind: "rpc", channel: "rpc:guarded", origin, tool: toolName, dangerous: danger, ok: false, error: "origin-denied", args: argsPreview(toolName, args) });
      return AUTH_DENIED_RESULT;
    }
    if (decision === "unknown") {
      startOriginModal(event); // background consent, deduped per origin
      audit({ kind: "rpc", channel: "rpc:guarded", origin, tool: toolName, dangerous: danger, ok: false, error: "origin-pending", args: argsPreview(toolName, args) });
      return AUTH_PENDING_RESULT;
    }
    // "allow" → fall through to the normal path
  } else {
    const originOk = await ensureOriginAuthorized(event);
    if (!originOk) {
      audit({ kind: "rpc", channel: "rpc:guarded", origin, tool: toolName, dangerous: danger, ok: false, error: "origin-unauthorized", args: argsPreview(toolName, args) });
      throw new Error(`未授权站点访问桌面 RPC（rpc:guarded：域名未加入白名单）`);
    }
  }
  if (danger) {
    const ok = await ensureRpcGrant(event, toolName, args);
    if (!ok) {
      audit({ kind: "rpc", channel: "rpc:guarded", origin, tool: toolName, dangerous: true, ok: false, error: "grant-denied", args: argsPreview(toolName, args) });
      throw new Error(`已拒绝敏感操作 ${toolName}（rpc:guarded：来源未获授权）`);
    }
  }
  try {
    // Throttled so a post-allow backlog drains a few at a time, not all at once.
    const result = await guardedDispatchLimit(() => dispatchRpc(event, toolName, args));
    audit({ kind: "rpc", channel: "rpc:guarded", origin, tool: toolName, dangerous: danger, ok: true, args: argsPreview(toolName, args) });
    return result;
  } catch (e) {
    console.error("[IPC Bridge] guarded error:", toolName, e.message);
    audit({ kind: "rpc", channel: "rpc:guarded", origin, tool: toolName, dangerous: danger, ok: false, error: e.message, args: argsPreview(toolName, args) });
    throw e;
  }
});
console.log("[IPC Bridge] RPC tools available via ipcRenderer.invoke('rpc'|'rpc:guarded', toolName, args)");

const workerClient = maybeCreateWorkerClient(authManager);

const PROJECT_ROOT = path.join(__dirname, "..");
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const MAC_LAUNCHER_SOURCE = path.join(PROJECT_ROOT, "cicy-dektop.command");
const MAC_LAUNCHER_TARGET = path.join(DESKTOP_DIR, "cicy-dektop.command");
const WINDOWS_LAUNCHER_TARGET = path.join(DESKTOP_DIR, "cicy-desktop.cmd");

function ensureDesktopLauncher() {
  // Disabled (主人: bug — 桌面别再放快捷方式): this used to drop a dev "npm start"
  // launcher on the Desktop EVERY launch — cicy-desktop.cmd on Windows,
  // cicy-dektop.command on macOS. That's unwanted clutter: the app is opened via
  // its installer / Start-menu / Dock shortcut, not this .cmd. No desktop
  // launcher is created anymore (both platforms). The ensure*DesktopLauncher
  // helpers below are kept dead-but-harmless for reference.
  return;
}

function ensureMacDesktopLauncher() {
  if (fs.existsSync(MAC_LAUNCHER_TARGET) || !fs.existsSync(MAC_LAUNCHER_SOURCE)) {
    return;
  }

  fs.copyFileSync(MAC_LAUNCHER_SOURCE, MAC_LAUNCHER_TARGET);
  fs.chmodSync(MAC_LAUNCHER_TARGET, 0o755);
  log.info(`[Launcher] Created desktop launcher at ${MAC_LAUNCHER_TARGET}`);
}

function ensureWindowsDesktopLauncher() {
  if (fs.existsSync(WINDOWS_LAUNCHER_TARGET)) {
    return;
  }

  const launcherContent = [
    "@echo off",
    "setlocal",
    `cd /d \"${PROJECT_ROOT}\"`,
    'if not exist package.json (',
    '  echo [ERROR] package.json not found in project directory',
    '  pause',
    '  exit /b 1',
    ')',
    'echo =========================================',
    'echo   CiCy Desktop Master + Worker',
    'echo   Project: %CD%',
    'echo =========================================',
    'npm start',
    'if errorlevel 1 (',
    '  echo.',
    '  echo [ERROR] Startup failed',
    '  pause',
    ')',
  ].join("\r\n");

  fs.writeFileSync(WINDOWS_LAUNCHER_TARGET, `${launcherContent}\r\n`, "utf8");
  log.info(`[Launcher] Created desktop launcher at ${WINDOWS_LAUNCHER_TARGET}`);
}

// ── Open at login ─────────────────────────────────────────────────────
// Register cicy-desktop to auto-start when the user signs in. Critical for
// Windows because cicy-code lives inside WSL — the daemon doesn't survive
// a Windows reboot, so we need cicy-desktop running to (a) trigger WSL boot
// and (b) start cicy-code via wsl.start().
//
// Honors `prefs.openAtLogin` if present; defaults to true on first run.
function ensureAutoLaunch() {
  try {
    const prefs = readPrefs();
    const want = prefs.openAtLogin !== false; // default true

    if (process.platform === "darwin") {
      // mac: register the STABLE Desktop applet as a login item — works for
      // npx/global installs (isPackaged=false), not just packaged .apps. We
      // register the applet (a fixed path that internally runs the global
      // cicy-desktop bin) instead of process.execPath, which is a transient
      // electron path that breaks on every version/cache change (the old auto-
      // start bug). Skip a pure source checkout so devs aren't auto-added.
      const installed = electronApp.isPackaged ||
        __dirname.includes(`${path.sep}node_modules${path.sep}`);
      if (!installed) return;
      ensureMacLoginItem(want);
      return;
    }

    // win/linux: unchanged — only manage login items for packaged builds.
    if (!electronApp.isPackaged) return;
    if (process.platform === "win32") {
      const cur = electronApp.getLoginItemSettings();
      if (cur.openAtLogin !== want) {
        electronApp.setLoginItemSettings({ openAtLogin: want, args: ["--hidden"] });
        log.info(`[autostart] openAtLogin → ${want}`);
      }
    } else if (process.platform === "linux") {
      ensureLinuxAutostart(want);
    }
  } catch (e) {
    log.warn(`[autostart] ensureAutoLaunch failed: ${e.message}`);
  }
}

// mac login item pointing at the Desktop applet (~/Desktop/CiCy Desktop.app).
// The applet is created by the launcher (bin/cicy-desktop ensureMacDesktopApp)
// BEFORE electron spawns, so it exists by the time this runs. Idempotent:
// always clears a stale entry first, then (re)adds when wanted.
function ensureMacLoginItem(want) {
  const name = "CiCy Desktop";
  const appletPath = path.join(os.homedir(), "Desktop", "CiCy Desktop.app");
  // Run the osascript ONLY when the desired state differs from what we last
  // applied. Each `tell application "System Events"` triggers macOS's
  // Automation-consent dialog, and because cicy-desktop is unpackaged/unsigned
  // it has no stable TCC identity — so the grant can't be remembered and the
  // dialog re-pops on EVERY launch. Persisting our own flag means we only touch
  // System Events on first configuration (or an actual on↔off change), so the
  // prompt appears at most once instead of every startup.
  const prefs = readPrefs();
  const state = want ? "on" : "off";
  if (prefs.macLoginItem === state) {
    log.info(`[autostart] mac login item already ${state} — skip (no re-prompt)`);
    return;
  }
  try {
    const { execFileSync } = require("child_process");
    const osa = (script) => execFileSync("osascript", ["-e", script], { stdio: "ignore" });
    osa(`tell application "System Events" to if login item "${name}" exists then delete login item "${name}"`);
    if (want && fs.existsSync(appletPath)) {
      osa(`tell application "System Events" to make login item at end with properties {name:"${name}", path:"${appletPath}", hidden:false}`);
      log.info(`[autostart] mac login item → ${appletPath}`);
    } else {
      log.info(`[autostart] mac login item ${want ? "skipped (applet missing)" : "removed"}`);
    }
    // Only persist the flag once the applet actually exists (so a first launch
    // that races applet creation re-tries next time instead of latching "on"
    // without ever registering).
    if (!want || fs.existsSync(appletPath)) writePrefs({ ...prefs, macLoginItem: state });
  } catch (e) {
    log.warn(`[autostart] mac login item failed: ${e.message}`);
  }
}

function readPrefs() {
  try {
    const p = path.join(electronApp.getPath("userData"), "prefs.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {};
}

function writePrefs(prefs) {
  try {
    const p = path.join(electronApp.getPath("userData"), "prefs.json");
    fs.writeFileSync(p, JSON.stringify(prefs, null, 2), "utf8");
  } catch (e) {
    log.warn(`[prefs] write failed: ${e.message}`);
  }
}

function ensureLinuxAutostart(want) {
  const dir = path.join(os.homedir(), ".config", "autostart");
  const file = path.join(dir, "cicy-desktop.desktop");
  if (!want) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) return;
  const exec = process.execPath;
  fs.writeFileSync(file, `[Desktop Entry]
Type=Application
Name=CiCy Desktop
Exec=${exec} --hidden
X-GNOME-Autostart-enabled=true
`, "utf8");
  log.info(`[autostart] wrote ${file}`);
}

// ── Sidecar health watchdog ───────────────────────────────────────────
// Periodically probe the cicy-code daemon at :8008. If it stops responding
// for two consecutive checks, attempt to restart it. Handles:
//   - Windows wakes from sleep: WSL2 distro stays up but cicy-code may have
//     been killed by the Linux kernel.
//   - WSL2 manual `wsl --shutdown`.
//   - Daemon crash.
//
// On macOS/Linux the watchdog respawns the bundled binary; on Windows it
// re-runs wsl.start() which re-launches cicy-code inside WSL.
let _sidecarWatchdogTimer = null;
function startSidecarWatchdog({ intervalMs = 30_000 } = {}) {
  if (_sidecarWatchdogTimer) return;
  let consecutiveFailures = 0;
  let restartInFlight = false;

  const tick = async () => {
    try {
      // An update() in progress intentionally stops cicy-code (to swap the binary)
      // and starts the new one itself — DON'T let the watchdog respawn the OLD
      // binary into that gap (it would race the swap and the update would "finish"
      // still on the old version). Pause until the update releases the flag.
      if (cicyCodeSidecar.isUpdating && cicyCodeSidecar.isUpdating()) { consecutiveFailures = 0; return; }
      const ok = await cicyCodeSidecar.probeExisting();
      if (ok) { consecutiveFailures = 0; return; }
      consecutiveFailures++;
      if (consecutiveFailures < 2) return;          // tolerate one transient failure
      if (restartInFlight) return;
      restartInFlight = true;
      log.warn(`[watchdog] sidecar unreachable for ${consecutiveFailures} ticks — restarting`);
      try {
        await cicyCodeSidecar.start({
          logPath: path.join(os.homedir(), "logs", "cicy-code-sidecar.log"),
          force: true,
        });
        consecutiveFailures = 0;
        log.info(`[watchdog] sidecar restarted`);
      } catch (e) {
        log.warn(`[watchdog] restart failed: ${e.message}`);
      } finally {
        restartInFlight = false;
      }
    } catch (e) {
      log.warn(`[watchdog] tick error: ${e.message}`);
    }
  };

  // First tick after a short warm-up so initial cicy-code start has time.
  setTimeout(tick, 15_000);
  _sidecarWatchdogTimer = setInterval(tick, intervalMs);
}

electronApp.whenReady().then(async () => {
  // Serve cicy://newtab (tab-browser start page) — must be after ready.
  require("./tabbrowser/newtab-protocol").installHandler();

  // Re-init i18n now that app is ready — getLocale() returns reliable values
  // only after the ready event. The module-load init may have picked English
  // on platforms (e.g. Windows) where LANG env is unset.
  // changeLanguage() is async; await it so tray/menu labels use the correct language.
  try {
    const realLocale = electronApp.getLocale && electronApp.getLocale();
    if (realLocale) await i18n.i18next.changeLanguage(i18n.pickLocale(realLocale));
    log.info(`[i18n] locale = ${i18n.i18next.language} (raw: ${realLocale})`);
  } catch (e) { log.warn(`[i18n] ready-time relocale failed: ${e.message}`); }

  // Rebrand the host (unpackaged) Electron bundle → "CiCy Desktop" name + icon.
  // May relaunch once on first run to apply the menu-bar name; everything after
  // here is skipped on that one relaunch path, so keep it first.
  brandHostElectron();
  setupAppIcons();
  ensureDesktopLauncher();
  ensureAutoLaunch();
  // 主人(2026-06 方向回调): mac/linux 改回 native cicy-code(:8008,本机直接跑二进制)——
  // colima VM 在 16G mac 上把内存压垮被 jetsam SIGKILL。Windows 仍走 docker(WSL :8009,
  // 由 sidecar-ipc 管),不在这里起 native。
  if (process.platform !== "win32") {
    // Start bundled cicy-code daemon as a sidecar. Reuses an existing instance on
    // :8008 if one is already running (probeExisting → adopt, never double-spawn).
    cicyCodeSidecar
      .start({ logPath: path.join(os.homedir(), "logs", "cicy-code-sidecar.log") })
      .then((c) => { if (c) log.info(`[Sidecar] cicy-code spawned pid=${c.pid}`); })
      .catch((e) => log.warn(`[Sidecar] cicy-code start failed: ${e.message}`));
    startSidecarWatchdog();

    // Auto-register the local sidecar as 本地团队 once :8008 answers (主人: 一装好就要
    // 有占位卡)。addTeam upserts by host:port + auto-fills api_token, so re-runs are
    // no-ops. A fresh boot may seed/npm-pull the binary first, so probe up to ~90s.
    (async () => {
      const sidecarPort = Number(process.env.CICY_CODE_PORT || 8008);
      const lt = require("./backends/local-teams");
      for (let i = 0; i < 30; i++) {
        try {
          if (await cicyCodeSidecar.probeExisting(sidecarPort)) {
            const r = await lt.addTeam({ base_url: `http://127.0.0.1:${sidecarPort}`, name: "本地团队" });
            if (r && r.ok) log.info(`[Sidecar] local team ${r.upserted ? "refreshed" : "registered"} (${r.id})`);
            else log.warn(`[Sidecar] local team auto-register failed: ${r && r.error}`);
            return;
          }
        } catch (e) { log.warn(`[Sidecar] local team auto-register error: ${e.message}`); }
        await new Promise((res) => setTimeout(res, 3000));
      }
      log.warn(`[Sidecar] local team auto-register gave up — :${sidecarPort} never came up`);
    })();
  }

  // Backend launcher: app menu + IPC handlers. Menu adds a Backends top-level
  // entry; IPC powers the launcher window (src/backends/launcher.html).
  backendsIPC.register({ sidecarLogPath: path.join(os.homedir(), "logs", "cicy-code-sidecar.log") });
  require("./backends/sidecar-ipc").register({ sidecarLogPath: path.join(os.homedir(), "logs", "cicy-code-sidecar.log") });

  // Browser-login loopback listener. Renderer calls auth:login-start when
  // the user clicks Login; main opens a 127.0.0.1 server + the browser,
  // and broadcasts auth:complete back to the homepage window once the
  // callback fires (or times out / fails).
  {
    const auth = require("./backends/auth-loopback");
    const { ipcMain: __ipcMainAuth } = require("electron");
    const { readGlobalConfig, updateGlobalConfig } = require("./utils/global-json");
    const GLOBAL_JSON = path.join(os.homedir(), "cicy-ai", "global.json");

    // Persist the cloud login durably in the MAIN process (global.json),
    // independent of the homepage renderer's origin. The renderer keeps the
    // token in localStorage, which Chromium scopes to the homepage window's
    // origin — and that origin has drifted historically (file:// today; the
    // remote worker / dev URLs in the past). A token saved under one origin
    // is invisible after the URL changes,
    // which forced the user to log in again and again. Storing it here and
    // restoring it on every homepage load makes "logged in once" survive origin
    // changes, restarts and public-URL switches. ONLY explicit logout clears it.
    const saveDesktopAuth = (p) => {
      try {
        updateGlobalConfig(GLOBAL_JSON, (c) => {
          c.desktopAuth = {
            token: p.token || "",
            accessToken: p.accessToken || "",
            userId: p.userId != null ? String(p.userId) : "",
            savedAt: Date.now(),
          };
          return c;
        });
        log.info("[auth] desktop login persisted to global.json (origin-independent)");
      } catch (e) { log.warn(`[auth] persist failed: ${e.message}`); }
    };

    // Shared result hook for BOTH login flows — the 127.0.0.1 loopback window AND
    // the email device-poll. Persist the token, report the device, notify the
    // renderer. A completed email login is thus indistinguishable downstream.
    const onAuthResult = (payload) => {
      if (payload && payload.token) {
        saveDesktopAuth(payload);
        // Now that we have a real owner-bound login token, report this
        // machine to the cloud (best-effort; safe to call repeatedly —
        // cloud upserts by (owner, deviceId)).
        try {
          // Order matters: register the DEVICE FIRST, THEN the local team(s).
          // POST /api/team/register 404s when the device isn't registered yet,
          // so firing both concurrently (the old bug) let team-sync race ahead
          // of device-register → 404 → gateway key never injected → apiKey 空.
          // Chain them so syncAllLocalTeams only runs after the device exists.
          require("./cloud/cloud-client")
            .registerDevice()
            .then(() => require("./backends/local-teams").syncAllLocalTeams())
            .catch((e) => log.warn(`[cloud] device/team register (on login) failed: ${e.message}`));
        } catch (e) { log.warn(`[cloud] device register hook failed: ${e.message}`); }
      }
      const hw = require("./backends/homepage-window");
      const w = hw.getHomepageWindow && hw.getHomepageWindow();
      if (w && !w.isDestroyed()) {
        try { w.webContents.send("auth:complete", payload); } catch {}
      }
    };

    __ipcMainAuth.handle("auth:login-start", async () => {
      try {
        const _info = await auth.startLogin({ onResult: onAuthResult });
        // Return the login URL so the renderer can offer a manual "open / copy
        // link" fallback when the browser didn't auto-open (openExternal failed).
        return { ok: true, url: _info && _info.url };
      } catch (e) {
        log.warn(`[auth] login-start failed: ${e.message}`);
        return { ok: false, error: e.message };
      }
    });
    __ipcMainAuth.handle("auth:login-cancel", () => { auth.cancel(); return { ok: true }; });

    // Email magic-link DEVICE-POLL login. Cross-device safe: the link can be
    // clicked on a phone and the desktop still completes via cloud polling
    // (todo#196). Reuses onAuthResult so it lands exactly like the loopback flow.
    const authEmail = require("./backends/auth-email");
    __ipcMainAuth.handle("auth:email-start", async (_e, email) => {
      try {
        const info = await authEmail.startEmailLogin({ email, onResult: onAuthResult });
        return { ok: true, email: info && info.email };
      } catch (e) {
        log.warn(`[auth] email-start failed: ${e.message}`);
        return { ok: false, error: e.message };
      }
    });
    __ipcMainAuth.handle("auth:email-cancel", () => { authEmail.cancel(); return { ok: true }; });

    // Origin-independent restore. The homepage SPA calls this on mount; if its
    // own (origin-scoped) localStorage has no token, it adopts this one — so a
    // homepage URL/origin change never forces a needless re-login.
    __ipcMainAuth.handle("auth:get-saved", () => {
      try {
        const c = readGlobalConfig(GLOBAL_JSON);
        const a = c && c.desktopAuth;
        if (a && a.token) {
          return { token: a.token, accessToken: a.accessToken || "", userId: a.userId || "" };
        }
      } catch (e) { log.warn(`[auth] get-saved failed: ${e.message}`); }
      return null;
    });

    // Explicit logout is the ONLY thing that clears the durable store.
    __ipcMainAuth.handle("auth:logout", () => {
      try {
        updateGlobalConfig(GLOBAL_JSON, (c) => { delete c.desktopAuth; return c; });
        log.info("[auth] desktop login cleared (explicit logout)");
      } catch (e) { log.warn(`[auth] logout clear failed: ${e.message}`); }
      return { ok: true };
    });

    // First-run terms gate (合规第一道整体同意). Persist acceptance in
    // global.json keyed by terms VERSION — a future version bump re-gates.
    // This is DISTINCT from the MITM CA opt-in (the compliance second consent);
    // accepting the terms NEVER enables HTTPS audit.
    __ipcMainAuth.handle("terms:status", (_e, version) => {
      try {
        const c = readGlobalConfig(GLOBAL_JSON);
        const a = c && c.termsAccepted;
        return { accepted: !!(a && a.version === version), version: a?.version || null };
      } catch { return { accepted: false, version: null }; }
    });
    __ipcMainAuth.handle("terms:agree", (_e, version) => {
      try {
        updateGlobalConfig(GLOBAL_JSON, (c) => {
          c.termsAccepted = { version, accepted_at: new Date().toISOString() };
          return c;
        });
        log.info(`[terms] accepted v${version}`);
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    });
    __ipcMainAuth.handle("terms:decline", () => {
      log.info("[terms] declined — quitting");
      setTimeout(() => electronApp.quit(), 50);
      return { ok: true };
    });
  }

  // Cloud device registration — if the user is already logged in, report this
  // machine (stable deviceId + platform/arch/publicIp) to the cloud on launch.
  // Best-effort and fully non-blocking; a no-op when not logged in (the login
  // onResult hook above covers the log-in-later case).
  try {
    // 1) Detect egress IP + IP region + system language and persist to
    //    global.json (deviceInfo) — the single source the get_device_info RPC,
    //    the chat-WS register, and the cloud report all read. The detection goes
    //    DIRECT (no proxy), each request times out, and the whole thing is
    //    fire-and-forget (never awaited → does not block startup). Runs even when
    //    not logged in so local config is always populated.
    // 2) THEN register the device with the cloud (no-op if not logged in) — it
    //    reads the just-persisted ip/region/syslang.
    // 3) THEN sync local teams (device must register first or /api/team/register 404s).
    const cc = require("./cloud/cloud-client");
    let sysLang = "";
    try { sysLang = (electronApp.getLocale && electronApp.getLocale()) || ""; } catch (_) {}
    cc.detectAndPersistDeviceInfo({ systemLanguage: sysLang })
      .then(() => cc.registerDevice())
      .then(() => require("./backends/local-teams").syncAllLocalTeams())
      .catch((e) => log.warn(`[cloud] device-info/register (on launch) failed: ${e.message}`));
  } catch (e) { log.warn(`[cloud] device-info launch hook failed: ${e.message}`); }

  // Cloud↔desktop title reconcile. The homepage drives the FAST cadence by window
  // visibility (聚焦 ~3s / 切回立即,见 App.jsx + localTeams:syncCloud IPC). This
  // 30s timer is just the SLOW fallback for when no homepage window is open / it's
  // hidden / logged-in-but-idle. Best-effort, no-op when logged out.
  if (!global.__cicyTitleSyncTimer) {
    global.__cicyTitleSyncTimer = setInterval(() => {
      try { require("./backends/local-teams").syncAllLocalTeams().catch(() => {}); } catch {}
    }, 30_000);
    if (global.__cicyTitleSyncTimer.unref) global.__cicyTitleSyncTimer.unref();
  }

  // Periodic per-window thumbnails → ~/cicy-files/window-thumbs (chrome-style
  // small previews on disk; override dir via CICY_THUMB_DIR). Best-effort.
  if (!global.__cicyThumbStarted) {
    global.__cicyThumbStarted = true;
    try {
      const info = require("./utils/window-thumbnails").startWindowThumbnails();
      log.info(`[thumbs] window thumbnails → ${info.dir} (every ${info.intervalMs}ms, maxW ${info.maxWidth})`);
    } catch (e) { log.warn(`[thumbs] start failed: ${e.message}`); }
  }

  // Periodic WHOLE-desktop snapshot → ~/cicy-files/desktop-snapshot/desktop.b64
  // so the cloud (cicy-code) can read the screen via the `desktop_snapshot` tool.
  // Windows uses a --disable-gpu child (GDI, no prompt); linux uses scrot.
  //
  // macOS: this spawns `screencapture`, which DOES trigger the Screen-Recording TCC
  // prompt — and on an ad-hoc-signed build (no Apple cert) the grant never sticks, so
  // the prompt fires over and over. So it's OFF by default on macOS (most users —
  // docker/team management — don't need the agent to watch their screen). Opt in with
  // CICY_DESKTOP_SNAPSHOT=1. Other platforms stay on (opt out with =0).
  const __snap = require("./utils/desktop-snapshot");
  if (!global.__cicyDesktopSnapStarted && __snap.snapshotEnabled()) {
    global.__cicyDesktopSnapStarted = true;
    try {
      const info = __snap.startDesktopSnapshots();
      log.info(`[desktop-snap] desktop snapshots → ${info.dir} (every ${info.intervalMs}ms, maxW ${info.maxWidth}, mode ${info.mode})`);
    } catch (e) { log.warn(`[desktop-snap] start failed: ${e.message}`); }
  }

  // Local-team discovery — reads ~/cicy-ai/global.json's cicyDesktopNodes
  // and probes each via /api/health. Pure local, never talks to the cloud
  // and never runs docker shells.
  {
    const lt = require("./backends/local-teams");
    const { ipcMain: __ipcLT } = require("electron");
    __ipcLT.handle("localTeams:list",    (_e, opts) => lt.list(opts || {}));
    __ipcLT.handle("localTeams:open",    (_e, id)   => lt.openTeam(id));
    __ipcLT.handle("localTeams:reload",  (_e, id, opts) => lt.reloadTeam(id, opts));
    __ipcLT.handle("localTeams:add",     (_e, spec)    => lt.addTeam(spec || {}));
    __ipcLT.handle("localTeams:remove",  (_e, id)      => lt.removeTeam(id));
    __ipcLT.handle("localTeams:update",  (_e, payload) => lt.updateTeam(payload?.id, payload?.patch || {}));
    __ipcLT.handle("localTeams:upgrade", (_e, id)      => lt.upgradeTeam(id));
    // Pull cloud title NOW (homepage calls this on window focus so a dash rename
    // reflects immediately instead of waiting for the 15s background tick).
    __ipcLT.handle("localTeams:syncCloud", async () => { try { await lt.syncAllLocalTeams(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

    // Webview → host-renderer relay. The Team Helper <webview> can't
    // directly mutate localTeams: instead its preload (webview-preload.js)
    // invokes "webview:relay" with {type, ...payload}; we forward to the
    // host BrowserWindow's renderer (App.jsx subscribes), wait for its
    // reply on "webview:relay-reply", and return that result to the
    // webview. This keeps the homepage renderer authoritative for UX
    // (it can confirm/deny + refresh state) while still giving the
    // webview a real awaitable promise.
    __ipcLT.handle("webview:relay", async (e, msg) => {
      const host = e.sender.hostWebContents;
      if (!host) return { ok: false, error: "no host webContents (not a webview?)" };
      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return await new Promise((resolve) => {
        const { ipcMain } = require("electron");
        let settled = false;
        const onReply = (_e, payload) => {
          if (!payload || payload.reqId !== reqId) return;
          if (settled) return;
          settled = true;
          ipcMain.removeListener("webview:relay-reply", onReply);
          resolve(payload.result);
        };
        ipcMain.on("webview:relay-reply", onReply);
        host.send("webview:relay", { reqId, msg });
        setTimeout(() => {
          if (settled) return;
          settled = true;
          ipcMain.removeListener("webview:relay-reply", onReply);
          resolve({ ok: false, error: "host renderer did not respond in 15s" });
        }, 15_000);
      });
    });
  }

  // Cloud-fetch proxy. Renderer hits this instead of fetch() directly because
  // (a) vite-dev origin localhost:8173 isn't on cicy-ai.com's CORS allowlist,
  // (b) file:// origin sends `Origin: null` which most APIs reject too. Node's
  // global fetch in main doesn't go through Chromium's CORS at all, so this
  // sidesteps both. Renderer→main IPC is the trust boundary; main forwards
  // anything the renderer asks for.
  {
    const { ipcMain: __ipcCloud } = require("electron");
    __ipcCloud.handle("cloud:fetch", async (_e, req) => {
      const { url, method = "GET", headers = {}, body = null } = req || {};
      if (!url) return { ok: false, status: 0, error: "no url" };
      try {
        const r = await fetch(url, { method, headers, body, cache: "no-store" });
        const text = await r.text();
        return {
          ok: r.ok,
          status: r.status,
          statusText: r.statusText,
          body: text,
        };
      } catch (e) {
        return { ok: false, status: 0, error: e.message || String(e) };
      }
    });
  }

  // Click handler for the "Check for Updates…" menu item. Triggers a fresh
  // update check; shows a dialog with the result. Auto-download + auto-install
  // already run via the existing event handlers in app-updater.init() — we
  // just surface the verdict so the user knows their click had effect.
  async function onCheckForUpdatesClicked() {
    const result = await appUpdater.checkInteractive();
    const currentVersion = electronApp.getVersion();
    if (result.status === "available") {
      const v = (result.info && result.info.version) || "?";
      dialog.showMessageBox({
        type: "info",
        message: i18n.t("menu.updateAvailable", { version: v }),
        buttons: ["OK"],
      });
    } else if (result.status === "up-to-date") {
      dialog.showMessageBox({
        type: "info",
        message: i18n.t("menu.upToDate", { version: currentVersion }),
        buttons: ["OK"],
      });
    } else {
      dialog.showMessageBox({
        type: "warning",
        message: i18n.t("menu.updateError", { error: result.error || "unknown" }),
        buttons: ["OK"],
      });
    }
  }

  const menuTemplate = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: i18n.t("menu.file"),
      submenu: [
        { label: i18n.t("menu.checkForUpdates"), click: onCheckForUpdatesClicked },
        { type: "separator" },
        { label: i18n.t("menu.close"), role: "close" },
        { label: i18n.t("menu.quit"), role: "quit" },
      ],
    },
    {
      label: i18n.t("menu.edit"),
      submenu: [
        { label: i18n.t("menu.undo"), role: "undo" },
        { label: i18n.t("menu.redo"), role: "redo" },
        { type: "separator" },
        { label: i18n.t("menu.cut"), role: "cut" },
        { label: i18n.t("menu.copy"), role: "copy" },
        { label: i18n.t("menu.paste"), role: "paste" },
        { label: i18n.t("menu.selectAll"), role: "selectAll" },
      ],
    },
    {
      label: i18n.t("menu.view"),
      submenu: [
        { label: i18n.t("menu.reload"), role: "reload" },
        { label: i18n.t("menu.forceReload"), role: "forceReload" },
        { label: i18n.t("menu.toggleDevTools"), role: "toggleDevTools" },
        { type: "separator" },
        { label: i18n.t("menu.actualSize"), role: "resetZoom" },
        { label: i18n.t("menu.zoomIn"), role: "zoomIn" },
        { label: i18n.t("menu.zoomOut"), role: "zoomOut" },
        { type: "separator" },
        { label: i18n.t("menu.toggleFullscreen"), role: "togglefullscreen" },
      ],
    },
    {
      label: i18n.t("menu.window"),
      submenu: [
        { label: i18n.t("menu.minimize"), role: "minimize" },
        ...(process.platform === "darwin"
          ? [{ label: i18n.t("menu.zoom"), role: "zoom" }, { type: "separator" }, { label: i18n.t("menu.front"), role: "front" }]
          : [{ label: i18n.t("menu.close"), role: "close" }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // Always open the homepage unless launched at login with --hidden.
  const hidden = process.argv.includes("--hidden");
  if (!hidden) {
    openHomepage();
  }
  if (hidden) log.info("[startup] --hidden: launched at login, staying in tray");
  // Start background update checks (Windows: silent download+install on quit;
  // macOS: unsigned — will error silently and fall back to manual download).
  const hw = require("./backends/homepage-window");
  appUpdater.init(hw.getHomepageWindow && hw.getHomepageWindow());

  // 为 webview partition 设置代理
  if (config.proxy) {
    const { session } = require("electron");
    const mainSession = session.fromPartition("persist:main");
    mainSession
      .setProxy({
        proxyRules: config.proxy,
      })
      .then(() => {
        log.info(`[Proxy] persist:main partition 已设置代理: ${config.proxy}`);
      })
      .catch((err) => {
        log.error("[Proxy] persist:main partition 设置代理失败:", err);
      });
  }
  // The HTTP server on PORT (default 8101) only matters for: (a) external
  // RPC clients hitting /rpc/*, (b) the master→worker bridge in cluster
  // mode, (c) the MCP/SSE endpoint when --mcp is enabled. None of these
  // are required for the homepage UI itself, which talks to the main
  // process via Electron IPC. So skip the listen by default; opt in with
  // CICY_DESKTOP_HTTP=1 (or CICY_DESKTOP_HTTP_PORT set explicitly).
  // Same opt-in as the CDP debug port above (see `automationEnabled`).
  const httpEnabled = automationEnabled;

  // Code that used to live inside server.listen(...) — startup work that
  // needs to happen after whenReady. Pulled out so we can run it whether
  // or not we end up listening on PORT.
  const onAppStarted = async () => {
    if (START_URL) {
      createWindow({ url: START_URL }, ACCOUNT);
    }

    // Persistent window registry: re-open windows that were still open when the
    // app last quit. Windows the user/agent closed stay "closed" and are not
    // reopened. Skip any url already live this session (homepage / START_URL).
    try {
      const { BrowserWindow } = require("electron");
      const registry = require("./utils/window-registry");
      const liveSet = new Set(
        BrowserWindow.getAllWindows()
          .map((w) => {
            try {
              const part = w.webContents.session.partition || "";
              const acc = part.startsWith("persist:sandbox-")
                ? parseInt(part.replace("persist:sandbox-", ""), 10)
                : 0;
              return `${acc}::${registry.normalizeUrl(w.webContents.getURL())}`;
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      );
      for (const e of registry.staleOpenEntries()) {
        if (!e.url) continue;
        if (liveSet.has(`${e.accountIdx || 0}::${registry.normalizeUrl(e.url)}`)) continue;
        log.info(`[WindowRegistry] Reopening ${e.url} (account ${e.accountIdx || 0})`);
        const opts = { url: e.url };
        if (e.bounds && typeof e.bounds === "object") Object.assign(opts, e.bounds);
        createWindow(opts, e.accountIdx || 0, true);
      }
    } catch (err) {
      log.error(`[WindowRegistry] reopen failed: ${err.message}`);
    }

    if (workerClient) {
      try {
        await workerClient.start();
        log.info(`[Cluster] Worker registered to ${process.env.CICY_MASTER_URL}`);
      } catch (error) {
        log.error(`[Cluster] Worker registration failed: ${error.message}`);
      }
    }
  };

  if (!httpEnabled) {
    log.info(`[MCP] HTTP server skipped (set CICY_DESKTOP_HTTP=1 or pass --mcp to enable)`);
    log.info(`[MCP] Remote debugger NOT running (automation disabled)`);
    onAppStarted();
  } else {
    server.listen(PORT, async () => {
      log.info(`[MCP] Log file: ${config.logFilePath}`);
      log.info(`[MCP] Server listening on http://localhost:${PORT}`);
      log.info(`[MCP] SSE endpoint: http://localhost:${PORT}/mcp`);
      log.info(`[MCP] REST API docs: http://localhost:${PORT}/docs`);
      log.info(`[MCP] Remote debugger: http://localhost:9221`);
      await onAppStarted();
    }).on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        log.error(`[MCP] Port ${PORT} is already in use — continuing without HTTP server`);
        // Don't exit; the homepage doesn't need this port. Run startup anyway.
        onAppStarted();
      } else {
        log.error("[MCP] Server error:", err);
      }
    });
  }
});

electronApp.on("window-all-closed", () => {
  // Keep app running
});

function cleanup() {
  log.info("[Cleanup] shutting down child services");
  // 退出保活(主人): macOS/Linux 的 native cicy-code(:8008)+ 它的 tmux agent 退出 App 时
  // 不杀 —— daemon spawn 成 detached,关窗口不打断正在跑的 agent,下次启动 probeExisting
  // adopt 即可。所以这里 **不** cicyCodeSidecar.stop()、**不** pkill cicy-code/tmux。

  // Reap only leftover legacy host helpers (ttyd / gotty / code-server) — never the
  // cicy-code daemon, never tmux, never the Docker engine. 主人: quitting CiCy Desktop
  // must NOT touch the cicy-code daemon (native :8008 keep-alive) NOR Docker (colima VM /
  // WSL distro — separate background services; the :8009 container is --restart unless-stopped).
  try {
    const { execSync } = require("child_process");

    if (process.platform === "win32") {
      // Windows: native cicy-code 不用(走 docker),只清 legacy host 残留。EXACT image
      // name,never wsl.exe / dockerd / vmmem / the WSL distro。
      for (const t of ["ttyd", "gotty", "code-server"]) {
        try { execSync(`taskkill /F /IM ${t}.exe`, { stdio: "ignore", windowsHide: true }); } catch {}
      }
    } else {
      // macOS / Linux: 只清 legacy host strays。CRITICAL: never `pkill -f cicy-code` —
      // 既会杀 native :8008 daemon(保活),又会误杀 colima 的 Lima hostagent
      // (`limactl ... colima-cicy-code`)。也不动 tmux(agent 会话保活)。
      for (const p of ["ttyd", "gotty", "code-server"]) {
        try { execSync(`pkill -f '${p}'`, { stdio: "ignore" }); } catch {}
      }
    }
  } catch (e) {
    log.warn(`[Cleanup] kill children failed: ${e.message}`);
  }

  if (workerClient) {
    workerClient.stop();
  }
  try { server.close(); } catch {}
}

let __isCleaningUp = false;
electronApp.on("before-quit", () => {
  electronApp.isQuitting = true;
  if (__isCleaningUp) return;
  __isCleaningUp = true;
  cleanup();
});

process.on("SIGTERM", () => { electronApp.isQuitting = true; cleanup(); electronApp.quit(); });
process.on("SIGINT",  () => { electronApp.isQuitting = true; cleanup(); electronApp.quit(); });

// 为所有 session（包括 webview partition）设置代理
electronApp.on("session-created", (session) => {
  if (config.proxy) {
    session
      .setProxy({
        proxyRules: config.proxy,
      })
      .then(() => {
        log.info(`[Proxy] Session ${session.partition || "default"} 已设置代理: ${config.proxy}`);
      })
      .catch((err) => {
        log.error(`[Proxy] Session ${session.partition || "default"} 设置代理失败:`, err);
      });
  }
});
