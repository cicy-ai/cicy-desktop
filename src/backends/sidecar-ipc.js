// IPC handlers for the cicy-code sidecar.
//
// cicy-code is no longer downloaded by an in-app installer — the sidecar runs
// it via `npx cicy-code` (mac/linux) or Docker (Windows); see
// src/sidecar/cicy-code.js. So this surface is just lifecycle + status:
//   sidecar:status  → { running }   — is something answering on :8008?
//   sidecar:start   → { ok, ... }   — start (or reuse) the daemon
//   sidecar:stop    → { ok }        — stop the daemon we spawned
//   sidecar:restart → { ok, ... }   — stop + fresh spawn (same version)
//   sidecar:update  → { ok, ... }   — stop + spawn cicy-code@latest
//
// (Removed: sidecar:check-latest / install / cancel / wsl-status / wsl-install,
// along with src/sidecar/installer.js and src/sidecar/wsl.js.)

const { ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sidecar = require("../sidecar/cicy-code");
const docker = require("../sidecar/docker");
const wslDocker = require("../sidecar/wsl-docker"); // Docker-版 via WSL2+Ubuntu (方案 A)

const PORT = Number(process.env.CICY_CODE_PORT || 8008);

// Docker-版 cicy-code: a SECOND, optional instance that runs inside Docker on
// :8009 (its own container + volume), alongside the native local daemon on
// :8008. The homepage "Docker cicy-code" card owns its lifecycle; if Docker
// Desktop is missing the card installs it first (installer downloads to the
// user's Desktop). The whole cicy home is persisted to a named volume so the
// entire container state survives recreation (主人: "把整个 docker 挂出来").
const APP_PORT = Number(process.env.CICY_DOCKER_APP_PORT || 8009);
const APP_CONTAINER = process.env.CICY_DOCKER_APP_CONTAINER || "cicy-code-docker";
const APP_VOLUME = process.env.CICY_DOCKER_APP_VOLUME || "cicy-team";
const APP_MOUNT = process.env.CICY_DOCKER_APP_MOUNT || "/home/cicy";
// The Docker-版 instance reaches the LLM through the cicy gateway, authenticated
// with the LOCAL 8008 team's api_token (主人: "key 用 local team 8008 的"). 8008
// is started by default on Windows and its token is already minted by the time
// the user opens the Docker card.
const GATEWAY_ENDPOINT = process.env.CICY_AI_GATEWAY_LLM_ENDPOINT || "https://gateway.cicy-ai.com";
function readLocalApiToken() {
  try {
    const p = path.join(os.homedir(), "cicy-ai", "global.json");
    return String(JSON.parse(fs.readFileSync(p, "utf8")).api_token || "");
  } catch { return ""; }
}

let registered = false;

function register({ sidecarLogPath } = {}) {
  if (registered) return;
  registered = true;

  ipcMain.handle("sidecar:status", async () => {
    const running = await sidecar.probeExisting(PORT);
    return { running };
  });

  // The ONE place the homepage gets cicy-code versions (主人令:"拿版本就一个方法").
  //   running   → the live daemon's /api/health version ("正在跑什么"的唯一真相)
  //   latest    → newest on npm (same number 更新 upgrades to)
  //   installed → on-disk binary (manifest)
  // The card derives 更新可用 / 已是最新 from THESE — never from ad-hoc probes.
  ipcMain.handle("sidecar:versions", async () => {
    const version = require("../sidecar/version");
    const [running, latest] = await Promise.all([version.running(PORT), version.latest()]);
    return { running: running || null, latest: latest || null, installed: version.installed() || null };
  });

  // ---- Windows Docker bootstrap (homepage's "no Docker" setup flow) ----
  // docker:status → what's missing; docker:bootstrap → install Docker (if
  // needed) + load image + start container, streaming progress back to the
  // homepage on 'docker:bootstrap-progress'. Bootstrap is win32-only.
  ipcMain.handle("docker:status", async () => {
    try {
      const st = await docker.checkStatus();        // { installed, imagePresent }
      const running = await docker.probeHealth(PORT);
      return { ...st, running, platform: process.platform };
    } catch (e) {
      return { installed: false, imagePresent: false, running: false, error: e.message, platform: process.platform };
    }
  });

  ipcMain.handle("docker:bootstrap", async (e) => {
    if (process.platform !== "win32") return { ok: false, error: "docker bootstrap is Windows-only" };
    try {
      const result = await docker.bootstrap({
        port: PORT,
        onProgress: (ev) => { try { e.sender.send("docker:bootstrap-progress", ev); } catch {} },
      });
      // Healthy local stack → make sure it shows up as a team ("本地团队就加
      // 上去了"). addTeam dedups by host:port, so re-runs are no-ops. The
      // api_token must be the CONTAINER's own (volume global.json) — the
      // host's token is a different credential and fails verify.
      if (result && result.ok) {
        try {
          const lt = require("./local-teams");
          const tok = await docker.readContainerToken(PORT);
          await lt.addTeam({
            base_url: `http://127.0.0.1:${PORT}`, name: "本地团队",
            ...(tok ? { api_token: tok } : {}),
          });
        } catch { /* best-effort — the stack itself is up */ }
      }
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Docker-版 cicy-code on :8009 — WSL2 + Ubuntu + Docker Engine (方案 A) ----
  // Card states (主人: 状态分清楚): running(:8009 healthy)→打开 / dockerRunning
  // (engine up)→启动 / installed(Ubuntu present)→启动 Docker / else→下载安装.
  ipcMain.handle("docker:app-status", async () => {
    try {
      const s = await wslDocker.status(APP_PORT); // { wsl, distro, engineUp, running }
      return { installed: !!s.distro, dockerRunning: !!s.engineUp, running: !!s.running, port: APP_PORT, platform: process.platform };
    } catch (e) {
      return { installed: false, dockerRunning: false, running: false, port: APP_PORT, platform: process.platform, error: e.message };
    }
  });

  // Common run options for the :8009 instance: its own container/volume + the
  // LLM gateway env keyed by the 8008 team's token. (WSL: whole-home mount via
  // -v <volume>:/home/cicy inside wsl-docker.)
  const appOpts = () => {
    const token = readLocalApiToken();
    const env = { CICY_AI_GATEWAY_LLM_ENDPOINT: GATEWAY_ENDPOINT };
    if (token) env.CICY_AI_GATEWAY_LLM_API_KEY = token;
    return { port: APP_PORT, container: APP_CONTAINER, volume: APP_VOLUME, env };
  };
  // Register the running :8009 instance as a (custom) team so the card's "打开"
  // reuses the token-injected open/reload flow. addTeam dedups by host:port.
  // Upsert the :8009 team with the CONTAINER's OWN live token. Critical: never
  // fall back to the host 8008 token (addTeam auto-fills global.json on an empty
  // api_token — that's the host credential, which 8009 rejects → login screen).
  // Returns the team id, or {ok:false} when the container token can't be read.
  const registerAppTeam = async () => {
    const lt = require("./local-teams");
    const tok = await wslDocker.readContainerToken(APP_PORT); // retried inside
    if (!tok) return { ok: false, error: "no_token", id: null };
    const r = await lt.addTeam({ base_url: `http://127.0.0.1:${APP_PORT}`, name: "Docker cicy-code", api_token: tok });
    return { ok: true, id: r && r.id };
  };

  // Card「打开」→ ALWAYS re-read the live container token and upsert the team
  // before opening, so the URL carries the current ?token= (a token captured at
  // install time goes stale after the container is recreated/reset). If the
  // token can't be read we refuse to open — opening tokenless / with the host
  // token just strands the user at a login screen (主人: 必须拿到 token 才能打开).
  ipcMain.handle("docker:app-open", async () => {
    if (process.platform !== "win32") return { ok: false, error: "windows_only" };
    try {
      const reg = await registerAppTeam();
      if (!reg.ok || !reg.id) return { ok: false, error: reg.error || "no_token" };
      const lt = require("./local-teams");
      const r = await lt.openTeam(reg.id);
      return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "open_failed" };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // One-click bootstrap (方案 A): ensure WSL2 → Ubuntu → Docker Engine → load
  // image → start :8009 container → health. Streams phase/progress on
  // 'docker:app-progress'. Idempotent + resumable → the modal's 重试 just re-runs.
  ipcMain.handle("docker:app-bootstrap", async (e) => {
    if (process.platform !== "win32") return { ok: false, error: "Docker cicy-code is Windows-only" };
    try {
      const result = await wslDocker.bootstrap({
        ...appOpts(),
        onProgress: (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} },
      });
      if (result && result.ok) await registerAppTeam();
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ⋯ menu → 重启 the :8009 container, wait for health.
  ipcMain.handle("docker:app-restart", async () => {
    try { const ok = await wslDocker.restart({ container: APP_CONTAINER, port: APP_PORT }); return { ok: !!ok }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ⋯ menu → 停止: graceful `docker stop` (data persists in the named volume).
  ipcMain.handle("docker:app-stop", async () => {
    try { await wslDocker.stop({ container: APP_CONTAINER }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ⋯ menu → 升级: re-pull the latest R2 image, re-create the :8009 container.
  ipcMain.handle("docker:app-upgrade", async (e) => {
    if (process.platform !== "win32") return { ok: false, error: "Docker cicy-code is Windows-only" };
    try {
      const result = await wslDocker.upgrade({
        ...appOpts(),
        onProgress: (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} },
      });
      if (result && result.ok) await registerAppTeam();
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Start (or reuse) the cicy-code daemon. probeExisting inside start() reuses
  // a healthy :8008; otherwise it spawns `npx cicy-code` / the Docker container.
  ipcMain.handle("sidecar:start", async () => {
    try {
      if (await sidecar.probeExisting(PORT)) return { ok: true, alreadyRunning: true };
      const child = await sidecar.start({ logPath: sidecarLogPath, force: false });
      // Wait briefly for it to bind :8008 so the homepage's poll flips to
      // "running" on the next tick.
      for (let i = 0; i < 20; i++) {
        if (await sidecar.probeExisting(PORT)) return { ok: true, pid: child?.pid || null };
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ok: true, pid: child?.pid || null, warning: "spawned but did not bind :8008 within 5s" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Stop the daemon we spawned. (A user-run / external instance we only
  // probed can't be killed from here — stop() no-ops when we hold no child.)
  ipcMain.handle("sidecar:stop", async () => {
    try {
      await sidecar.stop();
      // The daemon is gone — close any open team window pointing at it so the
      // user isn't left staring at a dead :8008 page (主人 bug report).
      try { require("./local-teams").closeLocalWindows(PORT); } catch {}
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Restart: stop + fresh spawn (same cached version). Wait for :8008 to
  // come back so the homepage poll flips to "running".
  ipcMain.handle("sidecar:restart", async () => {
    try {
      const child = await sidecar.restart({ logPath: sidecarLogPath });
      for (let i = 0; i < 20; i++) {
        if (await sidecar.probeExisting(PORT)) return { ok: true, pid: child?.pid || null };
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ok: true, pid: child?.pid || null, warning: "restarted but did not bind :8008 within 5s" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Update: stop + spawn cicy-code@latest (or reload the Docker image on
  // win32). The npx re-resolve / image pull can take a while on a cold cache,
  // so allow a longer window for :8008 to come back.
  ipcMain.handle("sidecar:update", async (e) => {
    // Stream phase/progress events to the homepage so the user SEES the
    // update working (download %, swap, restart) instead of a frozen label.
    const emit = (ev) => { try { e.sender.send("sidecar:op-progress", { op: "update", ...ev }); } catch {} };
    try {
      const child = await sidecar.update({ logPath: sidecarLogPath, port: PORT, emit });
      for (let i = 0; i < 240; i++) {
        if (await sidecar.probeExisting(PORT)) return { ok: true, pid: child?.pid || null };
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ok: true, pid: child?.pid || null, warning: "updated but did not bind :8008 within 60s" };
    } catch (err) {
      emit({ phase: "done", status: "error", message: `更新失败：${err.message}` });
      return { ok: false, error: err.message };
    }
  });

  // MITM CA elevation fallback: when POST /api/mitm/consent returns
  // need_elevation (cicy-code not running elevated), the homepage card calls
  // this to exec `<runtime cicy-code> mitm install-ca|uninstall-ca`, which
  // self-elevates (Win UAC / mac osascript / linux pkexec) — the OS prompt is
  // the compliance second-consent. Returns { ok, code, stderr }.
  ipcMain.handle("mitm:ca-exec", async (_e, action) => {
    const verb = action === "uninstall" ? "uninstall-ca" : "install-ca";
    const fs = require("fs"), os = require("os"), path = require("path");
    // Resolve a runnable cicy-code for the self-elevating CA install. Order:
    // runtime store (production schtasks build) → npx-cached platform binary
    // (macOS/global npx — runtime store is EMPTY there, which is why the card's
    // auto-elevate used to fail with "runtime binary not found") → global npm
    // launcher → bare name on PATH.
    let exe = null;
    try { exe = require("../sidecar/runtime").binPath("cicy-code"); } catch {}
    if (!exe) {
      const cands = [];
      try {
        const npxRoot = path.join(os.homedir(), ".npm", "_npx");
        for (const hash of fs.readdirSync(npxRoot)) {
          let pkgs = []; try { pkgs = fs.readdirSync(path.join(npxRoot, hash, "node_modules")); } catch {}
          for (const pkg of pkgs) {
            if (pkg.startsWith("cicy-code-")) {
              const p = path.join(npxRoot, hash, "node_modules", pkg, process.platform === "win32" ? "cicy-code.exe" : "cicy-code");
              if (fs.existsSync(p)) cands.push(p);
            }
          }
        }
      } catch {}
      cands.push("/usr/local/bin/cicy-code", "/opt/homebrew/bin/cicy-code");
      exe = cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || "cicy-code";
    }
    return await new Promise((resolve) => {
      const { execFile } = require("child_process");
      execFile(exe, ["mitm", verb], { windowsHide: false, timeout: 120000 }, (err, _stdout, stderr) => {
        if (err) resolve({ ok: false, code: err.code ?? 1, stderr: String(stderr || err.message).slice(0, 400) });
        else resolve({ ok: true, code: 0 });
      });
    });
  });
}

module.exports = { register };
