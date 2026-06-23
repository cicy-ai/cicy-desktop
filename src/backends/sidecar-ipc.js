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
const log = require("electron-log");
// Background-computed docker status lives here; the homepage READS this (never
// probes WSL live → never blocks the UI / strands it on 「重试检测」).
const DOCKER_STATUS_FILE = path.join(os.homedir(), "cicy-ai", "db", "docker-status.json");
const sidecar = require("../sidecar/cicy-code");
const docker = require("../sidecar/docker");
const wslDocker = require("../sidecar/wsl-docker"); // Docker-版 via WSL2+Ubuntu (方案 A, win32)
const colimaDocker = require("../sidecar/colima-docker"); // Docker-版 via Colima (Lima VM, darwin)
// 按平台分发 Docker-版 cicy-code 的运行层:darwin → Colima,win32 → WSL2。两者同接口
// (bootstrap/status/restart/stop/dockerRestart/recreate/update/upgrade/runContainer/
// readContainerToken),所以下面的 handler 共用一份逻辑,只换底层模块。
const appDocker = process.platform === "darwin" ? colimaDocker : wslDocker;
// Docker-版 cicy-code 支持的平台(win32 = WSL2,darwin = Colima)。其他平台不放行。
const APP_DOCKER_SUPPORTED = process.platform === "win32" || process.platform === "darwin";

const PORT = Number(process.env.CICY_CODE_PORT || 8008);

// Docker-版 cicy-code: a SECOND, optional instance that runs inside Docker on
// :8009 (its own container + volume), alongside the native local daemon on
// :8008. The homepage "Docker cicy-code" card owns its lifecycle; if Docker
// Desktop is missing the card installs it first (installer downloads to the
// user's Desktop). The whole cicy home is persisted to a named volume so the
// entire container state survives recreation (主人: "把整个 docker 挂出来").
// macOS is DOCKER-ONLY (主人指令: native 退役 — native 跑在宿主机无隔离会动用户数据).
// So on darwin the docker cicy-code IS the PRIMARY on :8008 (the slot the rest of the app
// already talks to; native no longer spawns there — see src/sidecar/cicy-code.js). The
// existing daemon/reconcile/ensureDockerTeam/appOpts machinery below just retargets to 8008
// — independent cloud team key, named-volume isolation, auto-start all come for free.
// win32 keeps the Docker-版 as an optional 2nd instance on :8009 alongside native :8008 (next).
const APP_PORT = Number(process.env.CICY_DOCKER_APP_PORT || (process.platform === "darwin" ? 8008 : 8009));
// container / volume 名都带上 port —— 一台机可以跑多个 docker(不同端口),各自
// 独立容器 + 独立 volume(数据隔离)+ 独立云端 team。docker-teams.json 也按 volume
// (含 port)区分。
const APP_CONTAINER = process.env.CICY_DOCKER_APP_CONTAINER || `cicy-code-docker-${APP_PORT}`;
const APP_VOLUME = process.env.CICY_DOCKER_APP_VOLUME || `cicy-team-${APP_PORT}`;
const APP_MOUNT = process.env.CICY_DOCKER_APP_MOUNT || "/home/cicy";
// 8008 and 8009 are ONE team (主人), so :8009 reaches the LLM through the cicy
// gateway using 8008's TEAM key — the `sk-cicy-…` apiKey already minted in 8008's
// global.json providers (NOT the api_token, which is only the local access
// credential). 8008 is up by the time the Docker card is used, so the key is
// ready — we just read it and pass it to the container. Same key ⇒ same billing.
const GATEWAY_ENDPOINT = process.env.CICY_AI_GATEWAY_LLM_ENDPOINT || "https://gateway.cicy-ai.com";
function readLocalGatewayKey() {
  try {
    const p = path.join(os.homedir(), "cicy-ai", "global.json");
    const g = JSON.parse(fs.readFileSync(p, "utf8"));
    const items = (g.providers && g.providers.items) || [];
    const pick =
      items.find((it) => it && it.apiKey && String(it.url || "").includes("gateway.cicy-ai.com")) ||
      items.find((it) => it && it.key === "defaultAnthropic" && it.apiKey) ||
      items.find((it) => it && it.apiKey);
    return pick ? String(pick.apiKey || "") : "";
  } catch { return ""; }
}

// ── Docker 独立云端 team ──────────────────────────────────────────────────────
// 主人令(2026-06-21):每个 Docker 容器要有自己独立的云端 team(8008 那个本机
// local team 不动)。云端是「一 deviceId 一 local team」,装不下一机多 docker,所以
// docker 走 POST /api/teams 建**独立 team**(不按 device)。首次建一次、把 teamId 存
// 本机(~/cicy-ai/db/docker-teams.json,按 volume 区分多个 docker);之后用 teamId 现
// 取 token。容器用这个 team 的 token 当网关 key(appOpts env);teamId 给 DockerCard
// 账单 + 改名(PATCH /api/teams/:id,和私有云卡同一套)。
const cc = (() => { try { return require("../cloud/cloud-client"); } catch { return null; } })();
const DOCKER_TEAMS_FILE = path.join(os.homedir(), "cicy-ai", "db", "docker-teams.json");
function readDockerTeams() { try { return JSON.parse(fs.readFileSync(DOCKER_TEAMS_FILE, "utf8")) || {}; } catch { return {}; } }
function writeDockerTeams(obj) { try { fs.mkdirSync(path.dirname(DOCKER_TEAMS_FILE), { recursive: true }); fs.writeFileSync(DOCKER_TEAMS_FILE, JSON.stringify(obj, null, 2)); } catch {} }
let dockerTeamReg = null; // { teamId, title, apiKey } — 缓存,appOpts 读它
// 主实例(APP_PORT===PORT,即 darwin docker-only 的 :8008)就是「本地团队」,不该叫
// 「Docker 团队」(那是第二实例 :8009 用的)。docker-only 下它是唯一/主团队。
const APP_TEAM_TITLE = (APP_PORT === PORT) ? "本地团队" : "Docker 团队";

// 确保这个 docker(按 volume)有独立云端 team;返回 { teamId, title, apiKey } 或 null。
async function ensureDockerTeam() {
  if (!cc || !cc.loginToken || !cc.loginToken()) return null; // 未登录 → appOpts 回退 8008 key
  try {
    const store = readDockerTeams();
    let rec = store[APP_VOLUME];
    if (!rec || !rec.teamId) {
      const created = await cc.createTeam({ title: APP_TEAM_TITLE, kind: "cloud" });
      if (!created || !created.ok) return null;
      // 强制把云端标题设成 APP_TEAM_TITLE:POST /api/teams 常忽略我们传的 title、
      // 回退成 owner/device 名,卡片就显示错了。PATCH 一下盖掉。
      try { await cc.renameTeam(created.teamId, APP_TEAM_TITLE); } catch {}
      store[APP_VOLUME] = { teamId: created.teamId, title: APP_TEAM_TITLE, titleForced: true };
      writeDockerTeams(store);
      dockerTeamReg = { teamId: created.teamId, title: APP_TEAM_TITLE, apiKey: created.apiKey };
      return dockerTeamReg;
    }
    // 既有 team:若还没强制过标题(老数据/上面那个 bug 建的),补一次 PATCH 成 "Docker
    // 团队",然后打上 titleForced 标记 —— 只补这一次,之后用户自己改名不会被覆盖。
    if (!rec.titleForced) {
      try { await cc.renameTeam(rec.teamId, APP_TEAM_TITLE); } catch {}
      rec.title = APP_TEAM_TITLE; rec.titleForced = true;
      store[APP_VOLUME] = rec; writeDockerTeams(store);
    }
    const apiKey = await cc.getTeamApiKey(rec.teamId);
    dockerTeamReg = { teamId: rec.teamId, title: rec.title, apiKey };
    return dockerTeamReg;
  } catch (e) { return null; }
}

let registered = false;

function register({ sidecarLogPath } = {}) {
  if (registered) return;
  registered = true;

  // ---- Docker status: computed by a dedicated NON-BLOCKING background daemon ----
  // The homepage's 「重试检测」 / 「未响应」 came from probing WSL live on the UI's
  // status call: a cold/busy WSL2 VM takes 10-20s to answer, timed out, and got
  // mis-read as unknown. Instead the daemon below detects status off the UI thread,
  // caches it (memory + file), AND auto-starts whatever is installed-but-down. The
  // docker:app-status handler just returns the cache — instant, never blocks.
  let _dockerStatusCache = null;
  let _dockerDaemonBusy = false;
  async function refreshDockerStatus() {
    try {
      const s = await appDocker.status(APP_PORT); // { wsl, distro, engineUp, running, unknown }
      _dockerStatusCache = { installed: !!s.distro, dockerRunning: !!s.engineUp, running: !!s.running, unknown: !!s.unknown, port: APP_PORT, platform: process.platform, ts: Date.now() };
    } catch (e) {
      _dockerStatusCache = { installed: false, dockerRunning: false, running: false, unknown: true, port: APP_PORT, platform: process.platform, error: e.message, ts: Date.now() };
    }
    try { fs.mkdirSync(path.dirname(DOCKER_STATUS_FILE), { recursive: true }); fs.writeFileSync(DOCKER_STATUS_FILE, JSON.stringify(_dockerStatusCache)); } catch {}
    return _dockerStatusCache;
  }
  async function reconcileDocker() {
    if (_dockerDaemonBusy) return _dockerStatusCache;
    _dockerDaemonBusy = true;
    try {
      const s = await refreshDockerStatus();
      // 没启动的给我启动: distro installed but :8009 not healthy (and WSL not unknown)
      // → bring it up. bootstrap is idempotent: it skips done steps and just runs
      // startEngine + the container. Skip when not installed (would silently pull
      // the 444MB rootfs) or unknown (WSL not answering — let the next tick retry).
      if (s.installed && !s.running && !s.unknown) {
        log.info("[docker-daemon] installed but :8009 down → auto-starting (bootstrap idempotent)");
        try { await appDocker.bootstrap(appOpts()); } catch (e) { log.warn(`[docker-daemon] auto-start failed: ${e.message}`); }
        await refreshDockerStatus();
      }
    } finally { _dockerDaemonBusy = false; }
    return _dockerStatusCache;
  }
  function startDockerStatusDaemon() {
    setTimeout(() => { reconcileDocker().catch(() => {}); }, 2000);     // shortly after startup
    setInterval(() => { reconcileDocker().catch(() => {}); }, 60000);   // keep fresh + self-heal
  }

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
  ipcMain.handle("docker:app-status", () => {
    // NON-BLOCKING: return what the background daemon already computed (memory →
    // file). NEVER probe WSL live here — that's what froze the UI / stranded the
    // card on 「重试检测」. Kick a refresh if we have nothing cached yet.
    if (_dockerStatusCache) return _dockerStatusCache;
    try { return JSON.parse(fs.readFileSync(DOCKER_STATUS_FILE, "utf8")); } catch {}
    reconcileDocker().catch(() => {});
    return { installed: false, dockerRunning: false, running: false, unknown: true, port: APP_PORT, platform: process.platform };
  });

  // 「重试检测」: FORCE a fresh probe right now (appStatus only reads the cache, so
  // clicking it changed nothing — the "点了没反应" bug). Returns the freshly-probed
  // status and kicks the auto-start reconcile in the background. If WSL is wedged
  // this resolves to unknown after the probe timeout, which the UI then surfaces.
  ipcMain.handle("docker:app-redetect", async () => {
    const s = await refreshDockerStatus();
    reconcileDocker().catch(() => {});
    return s;
  });

  // Common run options for the :8009 instance: its own container/volume + the
  // LLM gateway env keyed by the 8008 team's token. (WSL: whole-home mount via
  // -v <volume>:/home/cicy inside wsl-docker.)
  const appOpts = () => {
    // Docker 独立 team 的网关 key 优先(ensureDockerTeam 已缓存);未登录/未建成功
    // 时回退 8008 的 key,保证容器仍有 LLM key 可用。
    const gwKey = (dockerTeamReg && dockerTeamReg.apiKey) || readLocalGatewayKey();
    const env = { CICY_AI_GATEWAY_LLM_ENDPOINT: GATEWAY_ENDPOINT };
    if (gwKey) env.CICY_AI_GATEWAY_LLM_API_KEY = gwKey;
    return { port: APP_PORT, container: APP_CONTAINER, volume: APP_VOLUME, env };
  };
  // Register the running :8009 instance as a (custom) team so the card's "打开"
  // reuses the token-injected open/reload flow. addTeam dedups by host:port.
  // Upsert the :8009 team with the CONTAINER's OWN live token. Critical: never
  // fall back to the host 8008 token (addTeam auto-fills global.json on an empty
  // api_token — that's the host credential, which 8009 rejects → login screen).
  // Returns the team id, or {ok:false} when the container token can't be read.
  // Register the :8009 team WITHOUT a token. 主人: teams.json 不存 8009 的 token;
  // docker 的 token 是实时拿的. skipTokenAutofill stops addTeam from back-filling
  // the HOST 8008 token (the bug that made 8009 verify with 8008's token → login).
  const registerAppTeam = async () => {
    const lt = require("./local-teams");
    await ensureDockerTeam(); // 确保独立云端 team 存在 + 拿到 teamId/title
    const title = (dockerTeamReg && dockerTeamReg.title) || "Docker 团队";
    // is_docker + cloud_team_id are passed INTO addTeam so they land in the SAME
    // writeNodes as the node — before addTeam's fire-and-forget syncNameToCloud
    // runs. That's what stops the freshly-created :8009 node from device-registering
    // into THIS device's shared (8008) team and 串名. (addTeam also self-detects
    // is_docker by the :8009 port, so this is belt-and-suspenders.)
    const r = await lt.addTeam({
      base_url: `http://127.0.0.1:${APP_PORT}`,
      name: title,
      skipTokenAutofill: true,
      is_docker: true,
      cloud_team_id: (dockerTeamReg && dockerTeamReg.teamId) || undefined,
    });
    // Belt: re-affirm on the persisted node (no-op when addTeam already set them;
    // also late-binds cloud_team_id if ensureDockerTeam minted the team just now).
    if (r && r.id) {
      try { await lt.updateTeam(r.id, { is_docker: true, ...(dockerTeamReg && dockerTeamReg.teamId ? { cloud_team_id: dockerTeamReg.teamId } : {}) }); } catch {}
    }
    return { ok: true, id: r && r.id };
  };

  // Card「打开」→ read the container's OWN token LIVE from its volume right now,
  // then open the tab with THAT token. Never a stored/host token (主人: 打开前去
  // docker 里实时拿 token 再 open tab). Refuse to open if it can't be read —
  // opening tokenless / with the host token just strands the user at login.
  ipcMain.handle("docker:app-open", async () => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "unsupported_platform" };
    try {
      const tok = await appDocker.readContainerToken(APP_PORT, APP_CONTAINER, APP_VOLUME);
      if (!tok) return { ok: false, error: "no_token" };
      const reg = await registerAppTeam();
      if (!reg.id) return { ok: false, error: "register_failed" };
      const lt = require("./local-teams");
      const r = await lt.openTeam(reg.id, { token: tok }); // open with the LIVE token
      return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "open_failed" };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // One-click bootstrap (方案 A): ensure WSL2 → Ubuntu → Docker Engine → load
  // image → start :8009 container → health. Streams phase/progress on
  // 'docker:app-progress'. Idempotent + resumable → the modal's 重试 just re-runs.
  ipcMain.handle("docker:app-bootstrap", async (e) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "Docker cicy-code 仅支持 Windows / macOS" };
    try {
      await ensureDockerTeam(); // 启动前先确保独立云端 team + 拿到它的网关 key(appOpts 用)
      const result = await appDocker.bootstrap({
        ...appOpts(),
        onProgress: (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} },
      });
      if (result && result.ok) await registerAppTeam();
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ⋯ menu → 重启 cicy-code (supervisorctl restart cicy-code; daemons stay up).
  ipcMain.handle("docker:app-restart", async () => {
    try { const ok = await appDocker.restart({ container: APP_CONTAINER, port: APP_PORT, volume: APP_VOLUME }); return { ok: !!ok }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ⋯ menu → 重启 Docker:`docker restart` 整个容器(区别于上面 supervisorctl 重启 cicy-code)。
  ipcMain.handle("docker:app-docker-restart", async () => {
    try { await appDocker.dockerRestart({ container: APP_CONTAINER }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ⋯ menu → 重建 Docker:删容器 + 用新 env(docker team 网关 key)重新 docker run(保留
  // volume 数据)。换 key 的唯一途径。渲染端已 confirm。
  ipcMain.handle("docker:app-recreate", async () => {
    try {
      await ensureDockerTeam();
      await appDocker.recreate({ ...appOpts() });
      await registerAppTeam();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ⋯ menu → 更新 cicy-code: pull the latest cicy-code into the container +
  // restart it (no container recreate). Streams progress to the drawer.
  ipcMain.handle("docker:app-update", async (e) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "Docker cicy-code 仅支持 Windows / macOS" };
    try {
      return await appDocker.update({
        container: APP_CONTAINER, port: APP_PORT,
        onProgress: (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} },
      });
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ⋯ menu → 停止 cicy-code.
  ipcMain.handle("docker:app-stop", async () => {
    try { await appDocker.stop({ container: APP_CONTAINER }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ⋯ menu → 升级: re-pull the latest R2 image, re-create the :8009 container.
  ipcMain.handle("docker:app-upgrade", async (e) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "Docker cicy-code 仅支持 Windows / macOS" };
    try {
      await ensureDockerTeam();
      const result = await appDocker.upgrade({
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

  // Kick the non-blocking docker status daemon: detect on startup + every 60s,
  // cache to file, and auto-start what's installed-but-down. The UI just reads it.
  startDockerStatusDaemon();
}

module.exports = { register };
