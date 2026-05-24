// Homepage preload — last sweep. After this we should not need another
// .app rebuild for routine UI work; everything new lands in the Vite
// project at cicy-code/workers/desktop-render/src/ and HMRs in.
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
let __ipcSeq = 0;
function logInvoke(channel, ...args) {
  const id = ++__ipcSeq;
  const noisy = __noisy.has(channel);
  if (!noisy) console.log(`[ipc#${id}] call`, channel, ...args);
  return ipcRenderer.invoke(channel, ...args).then(
    (res) => { if (!noisy) console.log(`[ipc#${id}] reply`, channel, res); return res; },
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

// i18n: expose t(key, opts) and current locale to render. Resources are
// loaded once in the main process and shipped synchronously over IPC. Since
// preload runs in the main process for context-isolated windows, we can
// require the i18n module directly.
let __i18n;
try { __i18n = require("../i18n"); } catch (e) { __i18n = null; }
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
  },
  sidecar: {
    status:      ()  => logInvoke("sidecar:status"),
    wslStatus:   ()  => logInvoke("sidecar:wsl-status"),
    installWsl:  ()  => logInvoke("sidecar:wsl-install"),
    checkLatest: ()  => logInvoke("sidecar:check-latest"),
    install:     ()  => logInvoke("sidecar:install"),
    cancel:      ()  => logInvoke("sidecar:cancel"),
    onProgress:  (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on("sidecar:progress", handler);
      return () => ipcRenderer.removeListener("sidecar:progress", handler);
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
