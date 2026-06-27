// Homepage preload — last sweep. After this we should not need another
// .app rebuild for routine UI work; everything new lands in the Vite
// project at cicy-desktop/workers/render/src/ and HMRs in.
//
// Exposed surface:
//   window.electronRPC(tool, args)  — raw passthrough to ALL ~50 tools
//                                       registered via tool-registry
//                                       (exec_shell, file-tools, etc.)
//   window.cicy.backends.*          — backend registry / window-manager
//   window.cicy.windows.*           — open BrowserWindow tracker
//   window.cicy.updates.*           — GitHub release / version probe
//   window.cicy.clipboard.write     — write text to OS clipboard
//   window.cicy.app.quit            — quit the .app (ToS decline path)
//   window.cicy.shell.openExternal  — open URL in system browser
//   window.cicy.tos.{get,accept}    — userData/tos.json persistence
//   window.cicy.platform / .arch    — sync process meta, no IPC hop
//   window.cicy.system.*            — sugar over exec_shell for prereq probes
//   window.cicy.cicycode.*          — sugar over exec_shell for install/upgrade/start/stop
//   window.cicy.logs.tail(...)      — read recent lines of a known log file

const { contextBridge, ipcRenderer, shell } = require("electron");

// Wrap ipcRenderer.invoke so every renderer→main IPC call logs the channel,
// args, and the reply (or error) to the console. Skip noisy channels that
// fire on every render tick to avoid drowning the console.
const __noisy = new Set(["backends:list", "backends:health-all"]);
// Per-IPC call/reply tracing floods the console on every render tick and is
// pure debug noise for someone just running `npx cicy-desktop`. Off by default;
// set CICY_DEBUG=1 to restore it. Errors are always logged.
const __verbose = !!(process.env.CICY_DEBUG || process.env.CICY_VERBOSE);
let __ipcSeq = 0;
function logInvoke(channel, ...args) {
  const id = ++__ipcSeq;
  const noisy = __noisy.has(channel);
  if (__verbose && !noisy) console.log(`[ipc#${id}] call`, channel, ...args);
  return ipcRenderer.invoke(channel, ...args).then(
    (res) => { if (__verbose && !noisy) console.log(`[ipc#${id}] reply`, channel, res); return res; },
    (err) => { console.error(`[ipc#${id}] error`, channel, err); throw err; },
  );
}

// Sugar wrappers all route through the generic `rpc` channel which dispatches
// to any tool registered in src/tools/index.js. New capabilities = new RPC
// tool registration on the main side; renderer doesn't need new preload
// methods.
const rpc = (tool, args) => logInvoke("rpc", tool, args || {});

// Parse the standard `{ content: [{ type:"text", text:"..." }, ...], isError }`
// response from the tool layer.
function tx(res) {
  if (!res) return { ok: false, error: "no response" };
  if (res.isError) {
    const msg = (res.content || []).map(c => c.text).filter(Boolean).join("\n");
    return { ok: false, error: msg || "tool error" };
  }
  const txt = (res.content || []).map(c => c.text).filter(Boolean).join("\n");
  return { ok: true, stdout: txt };
}

async function execShell(command, opts = {}) {
  const r = await rpc("exec_shell", { command, ...opts });
  return tx(r);
}

contextBridge.exposeInMainWorld("electronRPC", (tool, args) => rpc(tool, args));

// i18n: expose t(key, opts) and current locale to render.
//
// IMPORTANT: this preload runs in the RENDERER process, so `require("../i18n")`
// gives a SEPARATE i18n instance from the main process — it has no idea what
// locale the app resolved. Left to its own lazy init() it would fall back to
// English (pickLocale(undefined) → FALLBACK), which is exactly why the homepage
// (e.g. the first-run terms gate) showed English even on zh-CN systems. So we
// pull the resolved locale from main over a synchronous IPC and init THIS
// instance with it. i18next.init() with inline resources is synchronous, so the
// language is set immediately and `locale` below reads the correct value.
let __i18n;
try {
  __i18n = require("../i18n");
  let mainLng = "";
  try { mainLng = ipcRenderer.sendSync("i18n:locale"); } catch (_) {}
  __i18n.init(mainLng || undefined);
  if (mainLng && __i18n.i18next.language !== __i18n.pickLocale(mainLng)) {
    __i18n.i18next.changeLanguage(__i18n.pickLocale(mainLng));
  }
} catch (e) { __i18n = null; }
contextBridge.exposeInMainWorld("cicyI18n", {
  t: (key, opts) => {
    if (!__i18n) return key;
    return __i18n.t(key, opts);
  },
  locale: __i18n ? __i18n.i18next.language : "en",
});

contextBridge.exposeInMainWorld("cicy", {
  // ------- platform meta (sync) -------
  platform: process.platform,         // "darwin" | "linux" | "win32"
  arch: process.arch,                 // "x64" | "arm64"
  // Absolute path to this preload file. (Legacy — kept for compatibility
  // with any caller that might still reference it.)
  preloadPath: __filename,
  // Absolute path to the dedicated <webview> preload (webview-preload.js).
  // homepage-preload itself can't be reused inside the helper <webview>
  // because it requires non-electron modules (../i18n) that throw in the
  // webview's sandboxed context, and because exposing the full cicy.*
  // surface to a remote SPA is unnecessary attack surface.
  webviewPreloadPath: require("path").join(__dirname, "webview-preload.js"),

  // ------- existing namespaces -------
  backends: {
    list:           ()      => logInvoke("backends:list"),
    add:            (input) => logInvoke("backends:add", input),
    remove:         (id)    => logInvoke("backends:remove", id),
    update:         (input) => logInvoke("backends:update", input),
    probe:          (input) => logInvoke("backends:probe", input),
    open:           (id)    => logInvoke("backends:open", id),
    health:         (id)    => logInvoke("backends:health", id),
    healthAll:      ()      => logInvoke("backends:health-all"),
    restartSidecar: ()      => logInvoke("backends:restart-sidecar"),
    resolveUrl:     (id)    => logInvoke("backends:resolve-url", id),
  },
  // cicy-code is installed/run by the sidecar via `npx cicy-code` (mac/linux)
  // or Docker (Windows) — no in-app downloader. Only lifecycle + status remain.
  sidecar: {
    status:      ()  => logInvoke("sidecar:status"),
    versions:    ()  => logInvoke("sidecar:versions"),
    start:       ()  => logInvoke("sidecar:start"),
    stop:        ()  => logInvoke("sidecar:stop"),
    restart:     ()  => logInvoke("sidecar:restart"),
    update:      ()  => logInvoke("sidecar:update"),
    getPublic:   ()  => logInvoke("sidecar:get-public"),       // 局域网访问开关状态
    setPublic:   (on) => logInvoke("sidecar:set-public", on),  // 设开关 + 自动重启 cicy-code
    // live {op, phase, status, message, progress?} events during update —
    // returns an unsubscribe fn.
    onOpProgress: (cb) => {
      const handler = (_e, ev) => { try { cb(ev); } catch {} };
      ipcRenderer.on("sidecar:op-progress", handler);
      return () => ipcRenderer.removeListener("sidecar:op-progress", handler);
    },
  },
  // MITM CA elevation fallback (exec self-elevating install-ca/uninstall-ca).
  mitm: {
    caExec: (action) => logInvoke("mitm:ca-exec", action), // "install" | "uninstall"
  },
  // First-run terms gate (合规第一道整体同意).
  terms: {
    status:  (version) => logInvoke("terms:status", version),
    agree:   (version) => logInvoke("terms:agree", version),
    decline: ()        => logInvoke("terms:decline"),
  },
  // Windows Docker bootstrap (install Docker → load image → start container).
  docker: {
    status:      ()  => logInvoke("docker:status"),
    bootstrap:   ()  => logInvoke("docker:bootstrap"),
    onProgress:  (cb) => {
      const handler = (_e, ev) => { try { cb(ev); } catch {} };
      ipcRenderer.on("docker:bootstrap-progress", handler);
      return () => ipcRenderer.removeListener("docker:bootstrap-progress", handler);
    },
    // Docker-版 cicy-code on :8009 (the homepage "Docker cicy-code" card).
    // appStatus → { installed, running, port, platform }; appBootstrap installs
    // Docker (if missing, installer → Desktop) + starts the :8009 container,
    // streaming phase/progress on 'docker:app-progress'.
    appStatus:    ()  => logInvoke("docker:app-status"),
    appRedetect:  ()  => logInvoke("docker:app-redetect"),   // 「重试检测」: FORCE a fresh probe (appStatus only reads cache)
    appBootstrap: ()  => logInvoke("docker:app-bootstrap"),
    appRestart:   ()  => logInvoke("docker:app-restart"),          // supervisorctl 重启 cicy-code
    appDockerRestart: () => logInvoke("docker:app-docker-restart"), // docker restart 整个容器
    appRecreate:  ()  => logInvoke("docker:app-recreate"),         // 删容器+重建(换 key,需 confirm)
    appAuthorizeHostSsh: () => logInvoke("docker:app-authorize-host-ssh"), // 仅 macOS:授权容器经 SSH 访问 Mac
    appUpdate:    ()  => logInvoke("docker:app-update"),
    appStop:      ()  => logInvoke("docker:app-stop"),
    appUpgrade:   ()  => logInvoke("docker:app-upgrade"),
    // Open :8009 with the live container token (refuses if it can't read it).
    appOpen:      ()  => logInvoke("docker:app-open"),
    openDir:      (which) => logInvoke("docker:open-dir", which), // "projects"→C:\projects, 否则 WSL 卷

    onAppProgress: (cb) => {
      const handler = (_e, ev) => { try { cb(ev); } catch {} };
      ipcRenderer.on("docker:app-progress", handler);
      return () => ipcRenderer.removeListener("docker:app-progress", handler);
    },
  },
  windows: {
    list:  ()   => logInvoke("windows:list"),
    focus: (id) => logInvoke("windows:focus", id),
  },
  updates: {
    check:            ()    => logInvoke("updates:check"),
    openReleasePage:  (url) => logInvoke("updates:open-release-page", url),
  },
  clipboard: {
    write: (text) => logInvoke("clipboard:write", text),
  },
  // Trusted-origins allowlist (Chrome-style site settings). Sites listed here may
  // receive the electronRPC bridge in profile 0 = run commands on this machine,
  // so the settings UI must warn loudly. list() returns [{host, builtin}], add/
  // remove return { ok, origins?:[{host,builtin}], error? } and take effect live.
  trustedOrigins: {
    list:   ()     => logInvoke("trustedOrigins:list"),
    add:    (host) => logInvoke("trustedOrigins:add", host),
    remove: (host) => logInvoke("trustedOrigins:remove", host),
  },
  // Read-only RPC audit log viewer (~/cicy-ai/db/rpc-audit.log). tail(limit)
  // returns { ok, entries:[{ts,kind,...}] newest-first, path }.
  rpcAudit: {
    tail: (limit) => logInvoke("rpcAudit:tail", { limit }),
  },
  // Open / reload a URL as a TAB in profile 0 (homepage cards open like the local
  // card — current profile, not a new window / system browser).
  tabs: {
    open:   (url, title) => logInvoke("tabs:open", { url, title }),
    reload: (url, title) => logInvoke("tabs:reload", { url, title }),
    reloadIfOpen: (url, title) => logInvoke("tabs:reloadIfOpen", { url, title }),
    activateIfOpen: (url) => logInvoke("tabs:activateIfOpen", { url }),
  },

  // ------- new bridges (last rebuild!) -------
  app: {
    quit:          ()  => logInvoke("app:quit"),
    getVersion:    ()  => logInvoke("app:get-version"),
    updateState:   ()  => logInvoke("app:update-state"),
    checkUpdate:   ()  => logInvoke("app:check-update"),
    installUpdate: ()  => logInvoke("app:install-update"),
    onUpdateState: (cb) => {
      const handler = (_e, state) => { try { cb(state); } catch {} };
      ipcRenderer.on("app:update-state", handler);
      return () => ipcRenderer.removeListener("app:update-state", handler);
    },
  },
  shell: {
    openExternal: (url) => logInvoke("shell:open-external", url),
  },
  tos: {
    get:    ()        => logInvoke("tos:get"),
    accept: (version) => logInvoke("tos:accept", version),
  },
  logs: {
    tail: (name, lines = 200) => logInvoke("logs:tail", { name, lines }),
  },

  // Browser-login loopback. loginStart kicks the flow (opens browser +
  // listens 127.0.0.1:<random>/cb). onComplete subscribes to the
  // result; payload is { token, state, reused, accessToken } on success
  // or { error } on mismatch / no-token / timeout. Returns an unsubscribe.
  auth: {
    loginStart:  ()  => logInvoke("auth:login-start"),
    loginCancel: ()  => logInvoke("auth:login-cancel"),
    // Email magic-link device-poll login (cross-device: the link works when
    // clicked on a phone). emailLoginStart resolves once the email is sent
    // ({ ok, email } | { ok:false, error }); the actual login lands later on the
    // same auth:complete event (onComplete below) as the loopback flow.
    emailLoginStart:  (email) => logInvoke("auth:email-start", email),
    emailLoginCancel: ()      => logInvoke("auth:email-cancel"),
    // Durable, origin-independent login persisted in main (global.json).
    // getSaved() restores it when this origin's localStorage is empty;
    // logout() clears it (the only thing that should).
    getSaved:    ()  => logInvoke("auth:get-saved"),
    logout:      ()  => logInvoke("auth:logout"),
    onComplete:  (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on("auth:complete", handler);
      return () => ipcRenderer.removeListener("auth:complete", handler);
    },
  },

  // Local-only teams (cicyDesktopNodes in ~/cicy-ai/global.json). list()
  // returns each node with a fresh /api/health probe; open(id) loads the
  // team's web UI in a new BrowserWindow.
  localTeams: {
    list:    (opts)        => logInvoke("localTeams:list", opts),
    open:    (id)          => logInvoke("localTeams:open", id),
    reload:  (id, opts)    => logInvoke("localTeams:reload", id, opts),
    add:     (spec)        => logInvoke("localTeams:add", spec),
    remove:  (id)          => logInvoke("localTeams:remove", id),
    update:  (id, patch)   => logInvoke("localTeams:update", { id, patch }),
    upgrade: (id)          => logInvoke("localTeams:upgrade", id),
    syncCloud: ()          => logInvoke("localTeams:syncCloud"),
    // Subscribe to relay requests forwarded from a child <webview>
    // (the Team Helper webview, via webview-preload.js). Each fire
    // delivers {reqId, msg:{type, ...payload}}; the renderer is
    // expected to do the work and call replyWebviewRelay(reqId, result).
    onWebviewRelay: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on("webview:relay", handler);
      return () => ipcRenderer.removeListener("webview:relay", handler);
    },
    replyWebviewRelay: (reqId, result) =>
      ipcRenderer.send("webview:relay-reply", { reqId, result }),
  },

  // Cross-origin fetch proxy. Renderer can't talk to cicy-ai.com directly
  // because the API doesn't CORS-allow file:// or localhost:8173. Main
  // does the request in Node (no CORS) and returns {ok, status, body}.
  cloud: {
    fetch: (url, opts) => logInvoke("cloud:fetch", { url, ...(opts || {}) }),
  },

  // Homepage window state. onFullscreen fires (bool) whenever the user
  // enter/leaves macOS native fullscreen — renderer toggles a data-attr
  // so CSS can hide the left gutter that's normally reserved for the
  // hiddenInset traffic-light buttons.
  window: {
    onFullscreen: (cb) => {
      const h = (_e, isFs) => { try { cb(!!isFs); } catch {} };
      ipcRenderer.on("window:fullscreen", h);
      return () => ipcRenderer.removeListener("window:fullscreen", h);
    },
  },

  deeplink: {
    // Listen for cicy://addTeam?title=&url=&token= activations.
    // Returns an unsubscribe function. cb({ title, url, token })
    onAddTeam: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on("deeplink:addTeam", handler);
      return () => ipcRenderer.removeListener("deeplink:addTeam", handler);
    },
  },

  // ------- system probes (sugar over exec_shell) -------
  system: {
    async checkNode() {
      const r = await execShell("node --version");
      if (!r.ok) return { ok: false, kind: "node", required: "Node.js 22+", version: null, installUrl: "https://nodejs.org/en/download" };
      const m = r.stdout.trim().match(/v?(\d+)\.(\d+)\.(\d+)/);
      const major = m ? Number(m[1]) : 0;
      return {
        ok: major >= 22,
        kind: "node",
        required: "Node.js 22+",
        version: m ? `v${m[1]}.${m[2]}.${m[3]}` : null,
        installUrl: "https://nodejs.org/en/download",
      };
    },
    async checkDocker() {
      const r = await execShell("docker --version");
      const installed = r.ok && /docker version/i.test(r.stdout);
      const m = r.stdout && r.stdout.match(/Docker version (\S+?)[,\s]/);
      return {
        ok: installed,
        kind: "docker",
        required: "Docker Desktop",
        version: m ? m[1] : null,
        installUrl: "https://www.docker.com/products/docker-desktop/",
      };
    },
    async checkPrereq() {
      // Pick the prereq the local card actually needs on this host.
      const platform = process.platform === "win32" ? "windows"
        : process.platform === "darwin" ? "darwin" : "linux";
      const base = platform === "windows"
        ? await this.checkDocker()
        : await this.checkNode();
      return { ...base, platform };
    },
    async checkCicyCodeInstalled() {
      // Try npx-no-install first (uses npm cache only, doesn't fetch); if that
      // fails, the package isn't installed locally.
      const r = await execShell("npx --no-install cicy-code --version 2>&1 || cicy-code --version 2>&1");
      const m = r.stdout && r.stdout.match(/(\d+\.\d+\.\d+)/);
      return { installed: !!m, version: m ? m[1] : null };
    },
  },

  // ------- cicy-code lifecycle (sugar over exec_shell + docker / npm) -------
  cicycode: {
    install:   ()       => execShell(process.platform === "win32"
      ? "docker pull ghcr.io/cicy-ai/cicy-code:latest"
      : "npm i -g cicy-code@latest"),
    upgrade:   ()       => execShell(process.platform === "win32"
      ? "docker pull ghcr.io/cicy-ai/cicy-code:latest"
      : "npm i -g cicy-code@latest"),
    start:     (port=8008) => execShell(process.platform === "win32"
      ? `docker run -d --name cicy-code -p ${port}:8008 ghcr.io/cicy-ai/cicy-code:latest`
      : `nohup npx --yes cicy-code > ~/.cicy-code.log 2>&1 & disown`),
    stop:      ()       => execShell(process.platform === "win32"
      ? "docker stop cicy-code && docker rm cicy-code"
      : "pkill -f 'cicy-code' || true"),
    uninstall: ()       => execShell(process.platform === "win32"
      ? "docker rmi ghcr.io/cicy-ai/cicy-code:latest"
      : "npm uninstall -g cicy-code"),
  },
});
