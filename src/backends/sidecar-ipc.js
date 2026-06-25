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
const i18n = require("../i18n");
const docker = require("../sidecar/docker");
const wslDocker = require("../sidecar/wsl-docker"); // Docker-版 via WSL2+Ubuntu (方案 A, win32)
const colimaDocker = require("../sidecar/colima-docker"); // Docker-版 via Colima (Lima VM, darwin)
const hostMihomo = require("../sidecar/host-mihomo"); // 宿主侧 mihomo —— 给系统 Chrome 的 per-profile 代理
// 按平台分发 Docker-版 cicy-code 的运行层:darwin → Colima,win32 → WSL2。两者同接口
// (bootstrap/status/restart/stop/dockerRestart/recreate/update/upgrade/runContainer/
// readContainerToken),所以下面的 handler 共用一份逻辑,只换底层模块。
const appDocker = process.platform === "darwin" ? colimaDocker : wslDocker;
// Docker-版 cicy-code 只剩 Windows(WSL2)。主人(2026-06 回调): macOS 改回 native cicy-code
// (:8008,colima 在 16G mac 上压垮内存被 jetsam 杀)→ darwin 不再走 docker,这里不放行,
// 所有 docker:app-* handler / reconcile / chrome-proxy 在 mac 上全部 no-op,DockerCard 不显示。
const APP_DOCKER_SUPPORTED = process.platform === "win32";

const PORT = Number(process.env.CICY_CODE_PORT || 8008);

// Docker-版 cicy-code: a SECOND, optional instance that runs inside Docker on
// :8009 (its own container + volume), alongside the native local daemon on
// :8008. The homepage "Docker cicy-code" card owns its lifecycle; if Docker
// Desktop is missing the card installs it first (installer downloads to the
// user's Desktop). The whole cicy home is persisted to a named volume so the
// entire container state survives recreation (主人: "把整个 docker 挂出来").
const APP_PORT = Number(process.env.CICY_DOCKER_APP_PORT || 8009);
// container / volume 名都带上 port —— 一台机可以跑多个 docker(不同端口),各自
// 独立容器 + 独立 volume(数据隔离)+ 独立云端 team。docker-teams.json 也按 volume
// (含 port)区分。
const APP_CONTAINER = process.env.CICY_DOCKER_APP_CONTAINER || `cicy-code-docker-${APP_PORT}`;
const APP_VOLUME = process.env.CICY_DOCKER_APP_VOLUME || `cicy-team-${APP_PORT}`;
const APP_MOUNT = process.env.CICY_DOCKER_APP_MOUNT || "/home/cicy";
// :8009 docker 的网关 endpoint。key 不再从 :8008 借(native 已退役)—— 容器只用它
// 自己独立云端 team 的 key(见 ensureDockerTeam / appOpts)。
const GATEWAY_ENDPOINT = process.env.CICY_AI_GATEWAY_LLM_ENDPOINT || "https://gateway.cicy-ai.com";

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
// 「Chrome 代理」开关:在宿主起一个 mihomo(host-mihomo)服务系统 Chrome 的 per-profile 代理,
// 配置从容器里 cp 出来。按 volume 存 docker-teams.json[volume].chromeProxy。
function chromeProxyEnabled() { try { return !!(readDockerTeams()[APP_VOLUME] || {}).chromeProxy; } catch { return false; } }
let dockerTeamReg = null; // { teamId, title, apiKey } — 缓存,appOpts 读它

// docker 团队的权威来源 = cloud(w-10122 #197):POST /api/team/docker/register 按
// (deviceId, port) get-or-create。幂等;失效/换设备/丢本机缓存都不会建重复 team;kind='docker';
// 软删后同 (device,port) 可重建;title 云端缺省 'Docker :<port>'(不回退 owner 名)。
// 本机 docker-teams.json 只当 cloud 不可达时的 offline fallback(缓存 teamId+key)。
// mac(colima)/ windows(WSL)同一套(这里平台无关,只有 appDocker 分平台)。
async function ensureDockerTeam() {
  if (!cc || !cc.loginToken || !cc.loginToken()) return null; // 未登录 → 先不带 key,登录后重建容器再补
  const cachedFallback = () => {
    try { const c = readDockerTeams()[APP_VOLUME]; if (c && c.apiKey) { dockerTeamReg = { teamId: c.teamId, title: c.title, apiKey: c.apiKey }; return dockerTeamReg; } } catch {}
    return null;
  };
  try {
    const r = await cc.registerDockerTeam({ port: APP_PORT });
    if (r && r.ok && r.apiKey) {
      dockerTeamReg = { teamId: r.teamId, title: r.title || `Docker :${APP_PORT}`, apiKey: r.apiKey };
      try { const store = readDockerTeams(); store[APP_VOLUME] = { ...(store[APP_VOLUME] || {}), teamId: r.teamId, title: dockerTeamReg.title, apiKey: r.apiKey }; writeDockerTeams(store); } catch {}
      return dockerTeamReg;
    }
    return cachedFallback(); // cloud 返回异常 → offline 兜底
  } catch (e) { return cachedFallback(); } // cloud 不可达 → offline 兜底
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
      // 容器里 cicy-code 的版本(DockerCard 底部显示):running 时读 :APP_PORT/api/health。
      let ver = null;
      if (s.running) { try { ver = await require("../sidecar/version").running(APP_PORT); } catch {} }
      // installed: distro 装了 OR :8009 健康(WSL 抽风查不到 distro 但容器在跑 → 也算装了,
      // 否则卡片误显「下载安装」)。wslUnmanaged: 服务在跑但 WSL 管不到 → 卡片显式提示异常。
      _dockerStatusCache = { installed: !!s.distro || !!s.healthy, dockerRunning: !!s.engineUp || !!s.healthy, running: !!s.running, unknown: !!s.unknown, wslUnmanaged: !!s.wslUnmanaged, version: ver, port: APP_PORT, platform: process.platform, chromeProxy: chromeProxyEnabled(), chromeProxyRunning: hostMihomo.running(), ts: Date.now() };
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
        try { await appDocker.bootstrap(await appOpts()); } catch (e) { log.warn(`[docker-daemon] auto-start failed: ${e.message}`); }
        await refreshDockerStatus();
      } else if (s.running) {
        // 自愈:容器在跑,但很可能是「首次启动时还没登录 / key 还没就位就建好了」的没 key 容器
        // —— runContainer 见到 :8009 健康就直接 adopt 不重建,key 永远进不去(Windows 实测的
        // 'llm key 没拿到')。这里:已能拿到 key + 容器里确实没 key → 带 key 重建一次(volume
        // 数据保留)。mac/win 同一套(hasGatewayKey 两个 docker 模块都实现了)。
        try {
          const opts = await appOpts();
          if (opts.env && opts.env.CICY_AI_GATEWAY_LLM_API_KEY && appDocker.hasGatewayKey
              && !(await appDocker.hasGatewayKey(APP_CONTAINER))) {
            log.info("[docker-daemon] 容器在跑但没网关 key → 带 key 重建(数据保留)");
            await appDocker.recreate(opts);
            try { await registerAppTeam(); } catch {}
            await refreshDockerStatus();
          }
        } catch (e) { log.warn(`[docker-daemon] key self-heal failed: ${e.message}`); }
        // Chrome 代理:开关开着但宿主 mihomo 没跑 → 拉起(从容器同步配置,幂等)。
        try { await maybeStartChromeProxy(); } catch (e) { log.warn(`[chrome-proxy] auto-start failed: ${e.message}`); }
      }
    } finally { _dockerDaemonBusy = false; }
    return _dockerStatusCache;
  }
  function startDockerStatusDaemon() {
    if (!APP_DOCKER_SUPPORTED) return; // mac/linux: native cicy-code,不跑 docker reconcile(否则 colima 反复重试)
    setTimeout(() => { reconcileDocker().catch(() => {}); }, 2000);     // shortly after startup
    setInterval(() => { reconcileDocker().catch(() => {}); }, 60000);   // keep fresh + self-heal
  }

  // 宿主 Chrome 代理:开关开着才做。从容器 cp 出 mihomo 配置 → host-mihomo 在宿主起/续。
  // 已在跑也同步一次配置(容器侧节点可能被云端更新),变了才重启。幂等。
  async function maybeStartChromeProxy() {
    if (!chromeProxyEnabled() || !APP_DOCKER_SUPPORTED) return;
    const yaml = await appDocker.readMihomoConfig(APP_CONTAINER);
    if (hostMihomo.binPresent() && hostMihomo.running()) {
      if (hostMihomo.writeConfig(yaml)) hostMihomo.start({ force: true });
      return;
    }
    await hostMihomo.enable({ containerYaml: yaml });
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
            base_url: `http://127.0.0.1:${PORT}`, name: i18n.t("localTeams.defaultName"),
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

  // Common run options for the :8009 instance: its own container/volume + the LLM
  // gateway env. 主人: :8009 必须用「它自己独立云端 team」的 key —— ensureDockerTeam
  // 没建就建(createTeam),用那个 teamId 的 key。绝不借别人的(native :8008 已退役,
  // 没得借,也不许借)。所以 appOpts 是 async:先 await ensureDockerTeam,确保容器启动
  // 前自己的 key 已就位;拿不到(未登录)就先不带 key,登录后「重建 Docker」再带上。
  const appOpts = async () => {
    await ensureDockerTeam().catch(() => {});
    const env = { CICY_AI_GATEWAY_LLM_ENDPOINT: GATEWAY_ENDPOINT };
    if (dockerTeamReg && dockerTeamReg.apiKey) env.CICY_AI_GATEWAY_LLM_API_KEY = dockerTeamReg.apiKey;
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
        ...(await appOpts()),
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
  ipcMain.handle("docker:app-recreate", async (e) => {
    try {
      await ensureDockerTeam();
      await appDocker.recreate({
        ...(await appOpts()),
        onProgress: (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} },
      });
      await registerAppTeam();
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ⋯ menu(仅 macOS)→ 「授权容器访问 Mac」:不挂 docker,改走 SSH。colima 自带
  // host.docker.internal 指向 Mac 主机,Mac sshd 已在 :22。把容器公钥写进 Mac 的
  // ~/.ssh/authorized_keys(容器没 key 就先生成),并在容器里写 ~/.ssh/config 加个 `mac`
  // 别名 → 容器内 `ssh mac` 即可上 Mac 主机跑命令。比挂 docker.sock 更通用、不碰 GID 权限。
  ipcMain.handle("docker:app-authorize-host-ssh", async () => {
    if (process.platform !== "darwin") return { ok: false, error: "仅 macOS 支持(容器经 host.docker.internal 访问 Mac)" };
    try {
      return await appDocker.authorizeHostSsh({ container: APP_CONTAINER });
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ⋯ menu 开关 → 「Chrome 代理」:在宿主起一个 mihomo 服务系统 Chrome 的 per-profile 代理
  // (127.0.0.1:2000N)。配置从容器里 cp 出来(含云端下发的真实节点),DNS 关掉、控制口错开。
  // 容器不再 publish 20001-32(那条路在 colima/WSL 下根本不通)。开关存 docker-teams.json[volume]。
  ipcMain.handle("docker:app-chrome-proxy", async (e, on) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "Chrome 代理仅支持 Windows / macOS" };
    try {
      const store = readDockerTeams();
      store[APP_VOLUME] = { ...(store[APP_VOLUME] || {}), chromeProxy: !!on };
      writeDockerTeams(store);
      if (on) {
        const containerYaml = await appDocker.readMihomoConfig(APP_CONTAINER);
        await hostMihomo.enable({ containerYaml, emit: (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} } });
      } else {
        hostMihomo.stop();
      }
      await refreshDockerStatus().catch(() => {});
      return { ok: true, chromeProxy: !!on, running: hostMihomo.running() };
    } catch (err) { return { ok: false, error: err.message }; }
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
        ...(await appOpts()),
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
  ipcMain.handle("sidecar:start", async (e) => {
    // 流式把安装进度推给抽屉(主人: "为什么不弹 drawer 显示安装日志,卡在哪我怎么知道"):
    //  - ensureNode 的 Node 下载进度 → 走 start({emit})
    //  - npx cicy-code + cicy-code 首次 `brew install tmux` 装依赖的输出 → 都写在 sidecarLogPath,
    //    这里 tail 这个文件、逐行 emit,用户就能看见在装啥、卡在哪。
    const emit = (ev) => { try { e.sender.send("sidecar:op-progress", { op: "start", ...ev }); } catch {} };
    try {
      if (await sidecar.probeExisting(PORT)) return { ok: true, alreadyRunning: true };
      let pos = 0; try { pos = fs.statSync(sidecarLogPath).size; } catch {}
      const tail = setInterval(() => {
        try {
          const sz = fs.statSync(sidecarLogPath).size;
          if (sz > pos) {
            const buf = Buffer.alloc(sz - pos);
            const fd = fs.openSync(sidecarLogPath, "r"); fs.readSync(fd, buf, 0, sz - pos, pos); fs.closeSync(fd);
            pos = sz;
            for (const line of buf.toString("utf8").split(/\r?\n/)) { const m = line.trim(); if (m) emit({ phase: "download", status: "running", message: m.slice(0, 240) }); }
          }
        } catch {}
      }, 500);
      const child = await sidecar.start({ logPath: sidecarLogPath, force: false, emit });
      // start() 返回 null = ensureEnv 失败(node/brew/tmux 没装成,emit 已说原因)或没 spawn 成。
      // **立刻报错返回**,别进 6 分钟干等(否则 child 一直是 null、break 条件永不成立,drawer 卡在
      // 「进行中」、不翻 error、不出重试按钮 —— 主人实测的 bug)。
      if (!child) {
        clearInterval(tail);
        if (await sidecar.probeExisting(PORT)) { emit({ phase: "done", status: "done", message: "cicy-code 已就绪 :8008" }); return { ok: true }; }
        emit({ phase: "done", status: "error", message: "❌ 环境准备失败(见上方日志),修好后点「重试」" });
        return { ok: false, error: "环境准备失败 — 见安装日志" };
      }
      // Node 下载 + cicy-code 首次 brew 装依赖很慢 → 等到 ~6 分钟;子进程退出(失败)立即停手。
      let up = false;
      for (let i = 0; i < 720; i++) {
        if (await sidecar.probeExisting(PORT)) { up = true; break; }
        if (child.exitCode != null) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      clearInterval(tail);
      if (up) { emit({ phase: "done", status: "done", message: "cicy-code 已就绪 :8008" }); return { ok: true, pid: child?.pid || null }; }
      if (child.exitCode != null) { emit({ phase: "done", status: "error", message: `cicy-code 启动失败(exit=${child.exitCode}),见上方日志` }); return { ok: false, error: `cicy-code exited (${child.exitCode}) — 见安装日志` }; }
      return { ok: true, pid: child?.pid || null, warning: "6 分钟内未就绪(可能还在装依赖,见日志)" };
    } catch (err) {
      emit({ phase: "done", status: "error", message: `启动失败：${err.message}` });
      return { ok: false, error: err.message };
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
