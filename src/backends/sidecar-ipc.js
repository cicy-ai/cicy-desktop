// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

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
const { auditDestructiveIpc } = require("./docker-audit");
const dockerProtect = require("../sidecar/docker-protect"); // 容器保护开关(默认开)
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
// Docker-版 cicy-code 只剩 Windows(WSL2)。(2026-06 回调): macOS 改回 native cicy-code
// (:8008,colima 在 16G mac 上压垮内存被 jetsam 杀)→ darwin 不再走 docker,这里不放行,
// 所有 docker:app-* handler / reconcile / chrome-proxy 在 mac 上全部 no-op,DockerCard 不显示。
const APP_DOCKER_SUPPORTED = process.platform === "win32";

const PORT = Number(process.env.CICY_CODE_PORT || 8008);

// Docker-版 cicy-code: a SECOND, optional instance that runs inside Docker on
// :8008 (its own container + volume), alongside the native local daemon on
// :8008. The homepage "Docker cicy-code" card owns its lifecycle; if Docker
// Desktop is missing the card installs it first (installer downloads to the
// user's Desktop). The whole cicy home is persisted to a named volume so the
// entire container state survives recreation ("把整个 docker 挂出来").
const APP_PORT = Number(process.env.CICY_DOCKER_APP_PORT || 8008);
// container / volume 名都带上 port —— 一台机可以跑多个 docker(不同端口),各自
// 独立容器 + 独立 volume(数据隔离)+ 独立云端 team。docker-teams.json 也按 volume
// (含 port)区分。
const APP_CONTAINER = process.env.CICY_DOCKER_APP_CONTAINER || `cicy-code-docker-${APP_PORT}`;
const APP_VOLUME = process.env.CICY_DOCKER_APP_VOLUME || `cicy-team-${APP_PORT}`;
const KOUBO_PORT = 8770;

// 用户自定义的额外发布端口(除 :8008 外,给容器内 agent 服务从 Windows 直达用)。
// 持久化在 userData/docker-ports.json,bootstrap/recreate 都会带上 -p。lazy 取
// 路径(app 未 ready 时不取)。口播在这个容器内按需启动，因此容器创建时必须
// 预先发布 :8770；服务未启动时映射保持空闲，不会额外启动 koubo。
function portsFile() { return path.join(require("electron").app.getPath("userData"), "docker-ports.json"); }
function sanitizePorts(arr) {
  const out = [], seen = new Set([APP_PORT, 8008]);
  for (const raw of Array.isArray(arr) ? arr : []) {
    const p = Number(raw);
    if (!Number.isInteger(p) || p < 1 || p > 65535 || seen.has(p)) continue;
    seen.add(p); out.push(p);
  }
  return out;
}
function readExtraPorts() {
  try {
    const j = JSON.parse(fs.readFileSync(portsFile(), "utf8"));
    return sanitizePorts([KOUBO_PORT, ...((j && Array.isArray(j.ports)) ? j.ports : [])]);
  } catch {
    return sanitizePorts([KOUBO_PORT]);
  }
}
function writeExtraPorts(ports) {
  try { fs.writeFileSync(portsFile(), JSON.stringify({ ports: sanitizePorts(ports) }, null, 2), "utf8"); } catch (e) { log.warn("[docker-ports] write failed:", e.message); }
}
const APP_MOUNT = process.env.CICY_DOCKER_APP_MOUNT || "/home/cicy";
// :8008 docker 的网关 endpoint。key 不再从 :8008 借(native 已退役)—— 容器只用它
// 自己独立云端 team 的 key(见 ensureDockerTeam / appOpts)。
const GATEWAY_ENDPOINT = process.env.CICY_AI_GATEWAY_LLM_ENDPOINT || "https://gateway.cicy-ai.com";

// ── Docker 独立云端 team ──────────────────────────────────────────────────────
// (2026-06-21):每个 Docker 容器要有自己独立的云端 team(8008 那个本机
// local team 不动)。云端是「一 deviceId 一 local team」,装不下一机多 docker,所以
// docker 走 POST /api/teams 建**独立 team**(不按 device)。首次建一次、把 teamId 存
// 本机(~/cicy-ai/db/docker-teams.json,按 volume 区分多个 docker);之后用 teamId 现
// 取 token。容器用这个 team 的 token 当网关 key(appOpts env);teamId 给 DockerCard
// 账单 + 改名(PATCH /api/teams/:id,和私有云卡同一套)。
const cc = (() => { try { return require("../cloud/cloud-client"); } catch { return null; } })();
const DOCKER_TEAMS_FILE = path.join(os.homedir(), "cicy-ai", "db", "docker-teams.json");
function readDockerTeams() { try { return JSON.parse(fs.readFileSync(DOCKER_TEAMS_FILE, "utf8")) || {}; } catch { return {}; } }
function writeDockerTeams(obj) { try { fs.mkdirSync(path.dirname(DOCKER_TEAMS_FILE), { recursive: true }); fs.writeFileSync(DOCKER_TEAMS_FILE, JSON.stringify(obj, null, 2)); } catch {} }
// 「Chrome 代理」始终开启(docker 装好就有,不要 Chrome 代理 switch)。docker 装好后
// 宿主自动起一个 mihomo(host-mihomo)服务系统 Chrome 的 per-profile 代理,配置从容器 cp 出来。
// 二进制在 bootstrap 时就预下载好;Windows 才有(APP_DOCKER_SUPPORTED)。
function chromeProxyEnabled() { return APP_DOCKER_SUPPORTED; }
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
  // 最近一次安装/启动失败的原因(reason + 人话 message),写进 docker-status.json 的
  // lastError,卡片和排障都能看到"为什么装不上",而不是只看到 installed:false。
  let _lastBootstrapError = null;
  // 硬失败(BIOS 没开虚拟化 / 子进程被拦 / WSL 功能启用失败)后暂停守护循环的自动安装:
  // 这些不会自己好,30 秒一轮地重来只会让卡片永远显示「安装已在进行中」。用户点「重试」
  // (docker:app-bootstrap)才清掉。
  let _autoBootstrapPaused = null;
  let _autoBootstrapRetryAt = 0; // 硬失败后的自动重试时间点(退避,不是永久暂停:用户不会自己修)
  // 退避:子进程被拦(安全软件开机后一段时间会自己放行)2 分钟一试;其余 15 分钟一试。
  const AUTO_RETRY_MS = { spawn_blocked: 2 * 60 * 1000, default: 15 * 60 * 1000 };
  const HARD_BOOTSTRAP_REASONS = new Set(["spawn_blocked", "virtualization_disabled", "wsl_enable_failed", "wsl_reboot_required"]);
  function recordBootstrapResult(result, err) {
    if (err) {
      const code = err && err.code;
      const reason = code === "EPERM" || /spawn EPERM/.test(err.message || "") ? "spawn_blocked" : "bootstrap_exception";
      _lastBootstrapError = { reason, message: err.message, ts: Date.now() };
    } else if (result && result.ok) {
      _lastBootstrapError = null; _autoBootstrapPaused = null; try { if (rebootCount() > 0) rebootCount(-99); } catch {} return;
    } else if (result) {
      _lastBootstrapError = { reason: result.reason || result.error || "bootstrap_failed", message: result.message || "", ts: Date.now() };
    } else return;
    if (_lastBootstrapError.reason === "wsl_reboot_required") scheduleReboot(90);
    if (HARD_BOOTSTRAP_REASONS.has(_lastBootstrapError.reason)) {
      _autoBootstrapPaused = _lastBootstrapError.reason;
      _autoBootstrapRetryAt = Date.now() + (AUTO_RETRY_MS[_lastBootstrapError.reason] || AUTO_RETRY_MS.default);
    }
    log.error(`[docker] bootstrap failed reason=${_lastBootstrapError.reason}${_lastBootstrapError.message ? ` — ${_lastBootstrapError.message}` : ""}${_autoBootstrapPaused ? " (auto-bootstrap paused until user retries)" : ""}`);
  }
  // WSL 功能启用后必须重启 Windows 才能继续。不等人:自动安排 90 秒后重启(桌面上会有
  // 系统倒计时提示),UI 可「取消」或「立即重启」。每次开机只安排一次。
  let _rebootScheduled = false;
  // 防重启循环:WSL 始终起不来时不能每次开机都重启。计数存 db/wsl-reboots.json,最多自动重启 2 次
  // (成功后 :8008 起来时清零)。
  const REBOOT_COUNT_FILE = path.join(os.homedir(), "cicy-ai", "db", "wsl-reboots.json");
  function rebootCount(delta) {
    let c = 0; try { c = Number(JSON.parse(fs.readFileSync(REBOOT_COUNT_FILE, "utf8")).count) || 0; } catch {}
    if (delta) { c = Math.max(0, c + delta); try { fs.mkdirSync(path.dirname(REBOOT_COUNT_FILE), { recursive: true }); fs.writeFileSync(REBOOT_COUNT_FILE, JSON.stringify({ count: c, ts: Date.now() })); } catch {} }
    return c;
  }
  function scheduleReboot(delaySec = 90) {
    if (_rebootScheduled || process.platform !== "win32") return false;
    if (delaySec > 10 && rebootCount() >= 2) { log.warn("[docker] auto-reboot skipped: already rebooted 2× for WSL without success"); return false; }
    _rebootScheduled = true;
    rebootCount(+1);
    try {
      require("child_process").execFile("shutdown", ["/r", "/t", String(delaySec), "/c", "CiCy Desktop: WSL2 功能已启用,需要重启 Windows 才能继续安装 Docker;登录后会自动继续。可在 CiCy Desktop 里取消。"], { windowsHide: true }, (err) => {
        if (err) { _rebootScheduled = false; log.warn(`[docker] schedule reboot failed: ${err.message}`); }
        else log.info(`[docker] Windows reboot scheduled in ${delaySec}s (WSL features enabled)`);
      });
    } catch (e) { _rebootScheduled = false; }
    return true;
  }
  function cancelReboot() {
    try { require("child_process").execFile("shutdown", ["/a"], { windowsHide: true }, () => {}); } catch {}
    _rebootScheduled = false;
  }
  ipcMain.handle("docker:reboot-now", () => { cancelReboot(); _rebootScheduled = false; return scheduleReboot(5); });
  ipcMain.handle("docker:reboot-cancel", () => { cancelReboot(); return true; });
  let _logFile = "";
  try { _logFile = log.transports.file.getFile().path; } catch {}
  let _dockerDaemonBusy = false;
  let _autostartEnsured = false;
  async function refreshDockerStatus() {
    try {
      const s = await appDocker.status(APP_PORT); // { wsl, distro, engineUp, running, unknown }
      // 容器里 cicy-code 的版本(DockerCard 底部显示):running 时读 :APP_PORT/api/health。
      let ver = null;
      if (s.running) { try { ver = await require("../sidecar/version").running(APP_PORT); } catch {} }
      // installed: distro 装了 OR :8008 健康(WSL 抽风查不到 distro 但容器在跑 → 也算装了,
      // 否则卡片误显「下载安装」)。wslUnmanaged: 服务在跑但 WSL 管不到 → 卡片显式提示异常。
      _dockerStatusCache = { installed: !!s.distro || !!s.healthy, dockerRunning: !!s.engineUp || !!s.healthy, running: !!s.running, unknown: !!s.unknown, wslUnmanaged: !!s.wslUnmanaged, wslWedged: !!s.wslWedged, version: ver, port: APP_PORT, platform: process.platform, chromeProxy: chromeProxyEnabled(), chromeProxyRunning: hostMihomo.running(), lastError: (!s.running && _lastBootstrapError) ? _lastBootstrapError : null, autoBootstrapPaused: _autoBootstrapPaused, logFile: _logFile, ts: Date.now() };
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
      // 打开 cicy-desktop 就保证 Windows/WSL 的 :8008 可用:
      //   - 已安装但停止 → 启动 WSL、dockerd 和容器;
      //   - 从未安装 → bootstrap 自动启用 WSL2、导入专用 distro、安装 Docker
      //     Engine、拉取镜像并启动 cicy-code。
      // bootstrap 幂等且可续跑;首次启用 WSL 若要求重启 Windows,下次登录 Desktop
      // 会再次进入这里并从已完成的步骤继续。unknown 表示 WSL 正卡住/未响应,
      // 此时不并发安装,留给下一轮检测或显式「修复 WSL」。
      if (!s.running && !s.unknown && _autoBootstrapPaused && Date.now() < _autoBootstrapRetryAt) {
        // 硬失败后退避(见 recordBootstrapResult);卡片显示 lastError,到点自动再试,用户点「重试」也行。
      } else if (!s.running && !s.unknown) {
        if (_autoBootstrapPaused) log.info(`[docker-daemon] backoff elapsed after ${_autoBootstrapPaused} → auto-retrying bootstrap`);
        log.info(`[docker-daemon] :8008 down (${s.installed ? "installed" : "not installed"}) → auto-bootstrapping WSL cicy-code`);
        try {
          await ensureDockerTeam().catch(() => {});
          const result = await appDocker.bootstrap(await appOpts());
          recordBootstrapResult(result);
          if (result && result.ok) {
            try { await registerAppTeam(); } catch {}
          } else if (result && result.reason) {
            log.warn(`[docker-daemon] auto-bootstrap paused: ${result.reason}`);
          }
        } catch (e) { recordBootstrapResult(null, e); log.warn(`[docker-daemon] auto-bootstrap failed: ${e.message}`); }
        await refreshDockerStatus();
      } else if (s.running) {
        // 桌面端不再向容器注入/自愈网关 key:LLM key 由 cicy-code 自己管理(global.json
        // 只读 api_token,绝不写)。
        // 开机自启链:每次会话确认一次登录任务 + wsl.conf [boot](幂等;老装机也能补上)。
        if (!_autostartEnsured && appDocker.ensureAutostart) {
          _autostartEnsured = true;
          try { await appDocker.ensureAutostart(); } catch (err) { log.warn(`[docker-daemon] ensureAutostart failed: ${err.message}`); }
        }
        // Chrome 代理:开关开着但宿主 mihomo 没跑 → 拉起(从容器同步配置,幂等)。
        try { await maybeStartChromeProxy(); } catch (e) { log.warn(`[chrome-proxy] auto-start failed: ${e.message}`); }
      }
    } finally { _dockerDaemonBusy = false; }
    return _dockerStatusCache;
  }
  function startDockerStatusDaemon() {
    if (!APP_DOCKER_SUPPORTED) {
      // mac/linux: native cicy-code, no docker reconcile. But macOS builds
      // upgraded from the old Colima era still carry a login LaunchAgent that
      // boots an unused `cicy-code` VM every login → tear that leftover down
      // once (no-op when the plist doesn't exist, i.e. fresh/native installs).
      if (process.platform === "darwin") colimaDocker.removeAutostart().catch(() => {});
      return;
    }
    setTimeout(() => { reconcileDocker().catch(() => {}); }, 2000);     // shortly after startup
    setInterval(() => { reconcileDocker().catch(() => {}); }, 60000);   // keep fresh + self-heal
  }

  // 宿主 Chrome 代理(始终开启):从容器 cp 出 mihomo 配置 → host-mihomo 在宿主起/续。
  // 已在跑也同步一次配置(容器侧节点可能被云端更新),变了才重启。幂等。二进制不在会自动下。
  async function maybeStartChromeProxy() {
    if (!APP_DOCKER_SUPPORTED) return;
    const [yaml, selections] = await Promise.all([
      appDocker.readMihomoConfig(APP_CONTAINER),
      appDocker.readMihomoSelections(APP_CONTAINER),
    ]);
    if (hostMihomo.binPresent() && hostMihomo.running()) {
      if (hostMihomo.writeConfig(yaml)) hostMihomo.start({ force: true });
      await hostMihomo.syncSelections(selections);
      return;
    }
    await hostMihomo.enable({ containerYaml: yaml, selections });
  }

  ipcMain.handle("sidecar:status", async () => {
    const running = await sidecar.probeExisting(PORT);
    return { running };
  });

  // The ONE place the homepage gets cicy-code versions ("拿版本就一个方法").
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
      if (result && result.ok) _lastBootstrapError = null;
      else if (result) {
        _lastBootstrapError = { reason: result.reason || result.error || "bootstrap_failed", message: result.message || "", ts: Date.now() };
        log.error(`[docker] bootstrap failed reason=${_lastBootstrapError.reason}${_lastBootstrapError.message ? ` — ${_lastBootstrapError.message}` : ""}`);
      }
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
      _lastBootstrapError = { reason: "bootstrap_exception", message: err.message, ts: Date.now() };
      log.error(`[docker] bootstrap threw: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  // ---- Docker-版 cicy-code on :8008 — WSL2 + Ubuntu + Docker Engine (方案 A) ----
  // Card states (状态分清楚): running(:8008 healthy)→打开 / dockerRunning
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

  // Common run options for the :8008 instance: its own container/volume + the LLM
  // gateway env. :8008 必须用「它自己独立云端 team」的 key —— ensureDockerTeam
  // 没建就建(createTeam),用那个 teamId 的 key。绝不借别人的(native :8008 已退役,
  // 没得借,也不许借)。所以 appOpts 是 async:先 await ensureDockerTeam,确保容器启动
  // 前自己的 key 已就位;拿不到(未登录)就先不带 key,登录后「重建 Docker」再带上。
  const appOpts = async () => {
    await ensureDockerTeam().catch(() => {});
    // 只传网关地址,不传 key —— cicy-code 自己配置/持有 LLM key,桌面端不写。
    const env = { CICY_AI_GATEWAY_LLM_ENDPOINT: GATEWAY_ENDPOINT };
    return { port: APP_PORT, container: APP_CONTAINER, volume: APP_VOLUME, env, extraPorts: readExtraPorts(), dockerSock: sidecar.isDood() };
  };
  // Register the running :8008 instance as a (custom) team so the card's "打开"
  // reuses the token-injected open/reload flow. addTeam dedups by host:port.
  // Upsert the :8008 team with the CONTAINER's OWN live token. Critical: never
  // fall back to the host 8008 token (addTeam auto-fills global.json on an empty
  // api_token — that's the host credential, which 8008 rejects → login screen).
  // Returns the team id, or {ok:false} when the container token can't be read.
  // Register the :8008 team WITHOUT a token. teams.json 不存 8008 的 token;
  // docker 的 token 是实时拿的. skipTokenAutofill stops addTeam from back-filling
  // the HOST 8008 token (the bug that made 8008 verify with 8008's token → login).
  const registerAppTeam = async () => {
    const lt = require("./local-teams");
    await ensureDockerTeam(); // 确保独立云端 team 存在 + 拿到 teamId/title
    const title = (dockerTeamReg && dockerTeamReg.title) || "Docker 团队";
    // is_docker + cloud_team_id are passed INTO addTeam so they land in the SAME
    // writeNodes as the node — before addTeam's fire-and-forget syncNameToCloud
    // runs. That's what stops the freshly-created :8008 node from device-registering
    // into THIS device's shared (8008) team and 串名. (addTeam also self-detects
    // is_docker by the :8008 port, so this is belt-and-suspenders.)
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
  // then open the tab with THAT token. Never a stored/host token (打开前去
  // docker 里实时拿 token 再 open tab). Refuse to open if it can't be read —
  // opening tokenless / with the host token just strands the user at login.
  // 原则:打开走的每条命令/输出/错误都要可见(收进 log[] 同时实时 push 到 drawer),
  // 失败给可排查的 hint + 可重试。健壮:全程 try/catch,任何一步都不抛到 ipc 外。
  // 在资源管理器打开目录。which="projects" → C:\projects(bind 挂载,容器 ~/projects);
  // 否则 → WSL 卷 \\wsl$\<distro>\…\volumes\<vol>\_data(= 容器 /home/cicy)。
  ipcMain.handle("docker:open-dir", async (_e, which) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "unsupported" };
    try {
      const { shell } = require("electron");
      let p;
      if (which === "projects") {
        p = "C:\\projects";
        try { fs.mkdirSync(p, { recursive: true }); } catch (e2) {}
      } else {
        const distro = process.env.CICY_WSL_DISTRO || "cicy-code-wsl";
        p = `\\\\wsl$\\${distro}\\var\\lib\\docker\\volumes\\${APP_VOLUME}\\_data`;
      }
      const err = await shell.openPath(p); // "" on success, error string on fail
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("docker:app-open", async (e) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "unsupported_platform", hint: "Docker cicy-code 仅支持 Windows" };
    const log = [];
    const onLog = (ev = {}) => {
      const line = { phase: "open", status: ev.status || "running", message: ev.message || "" };
      log.push(line);
      try { e.sender.send("docker:app-progress", line); } catch (e2) {}
    };
    const tt = (k, o) => i18n.t(`dockerOpen.${k}`, o);
    try {
      onLog({ message: tt("readToken", { container: APP_CONTAINER, volume: APP_VOLUME }) });
      const tok = await appDocker.readContainerToken(APP_PORT, APP_CONTAINER, APP_VOLUME, { onLog });
      if (!tok) {
        // 给出能排查的原因,而不是甩个 no_token。hint 只在 return(渲染层 finish 显示一次,
        // 不再 onLog 进 log[],否则和 finish 重复弹两遍)。
        let hint = tt("hintNoToken");
        try {
          const s = await refreshDockerStatus();
          if (s && s.wslUnmanaged) hint = tt("hintWslUnmanaged", { port: APP_PORT });
          else if (s && !s.running) hint = tt("hintNotRunning");
        } catch (e2) {}
        return { ok: false, error: "no_token", hint, log };
      }
      onLog({ message: tt("registering") });
      const reg = await registerAppTeam();
      if (!reg.id) return { ok: false, error: "register_failed", hint: tt("hintRegisterFailed"), log };
      onLog({ message: tt("opening", { url: `http://127.0.0.1:${APP_PORT}` }) });
      const lt = require("./local-teams");
      const r = await lt.openTeam(reg.id, { token: tok }); // open with the LIVE token
      if (r && r.ok) { onLog({ status: "done", message: tt("opened") }); return { ok: true }; }
      return { ok: false, error: (r && r.error) || "open_failed", hint: tt("hintOpenFailed", { err: (r && r.error) || "open_failed" }), log };
    } catch (err) {
      return { ok: false, error: err.message, hint: tt("hintException", { err: err.message }), log };
    }
  });

  // One-click bootstrap (方案 A): ensure WSL2 → Ubuntu → Docker Engine → load
  // image → start :8008 container → health. Streams phase/progress on
  // 'docker:app-progress'. Idempotent + resumable → the modal's 重试 just re-runs.
  ipcMain.handle("docker:app-bootstrap", async (e) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "Docker cicy-code 仅支持 Windows" };
    try {
      await ensureDockerTeam(); // 启动前先确保独立云端 team + 拿到它的网关 key(appOpts 用)
      const emit = (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} };
      // docker 起来之前就把宿主 mihomo 二进制下载安装好(给系统 Chrome 代理用,始终开启)。
      // 纯宿主侧、不依赖容器,和 docker 装机并行;OSS 下载,失败不挡 docker(reconcile 会重试)。
      try { await hostMihomo.ensureBinary({ emit }); } catch (err) { log.warn(`[chrome-proxy] ensureBinary failed: ${err.message}`); }
      _autoBootstrapPaused = null; // 用户主动重试 → 解除暂停
      const result = await appDocker.bootstrap({ ...(await appOpts()), onProgress: emit });
      recordBootstrapResult(result);
      if (result && result.ok) {
        await registerAppTeam();
        // 容器起来了 → 立刻从容器同步配置并拉起 host mihomo(不必等 60s reconcile)。
        try { await maybeStartChromeProxy(); } catch (err) { log.warn(`[chrome-proxy] start after bootstrap failed: ${err.message}`); }
      }
      await refreshDockerStatus().catch(() => {});
      return result;
    } catch (err) {
      recordBootstrapResult(null, err);
      await refreshDockerStatus().catch(() => {});
      return { ok: false, error: err.message, reason: _lastBootstrapError && _lastBootstrapError.reason, message: err.message };
    }
  });

  // 「修复 WSL」: WSL 卡死(wslWedged)时用户一键自救。先试重启 LxssManager;若还卡死(深度
  // 死锁,杀不动)→ 返回 needsReboot,渲染层提示重启电脑(重启后启动 bootstrap 会自动重置坏
  // distro + 重新导入)。服务恢复了就顺手跑一遍 bootstrap 自愈。
  ipcMain.handle("docker:app-repair-wsl", async (e) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "仅 Windows" };
    const emit = (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} };
    try {
      const r = await appDocker.repairWsl({ emit });
      if (r && r.ok) {
        try { await ensureDockerTeam(); await appDocker.bootstrap({ ...(await appOpts()), onProgress: emit }); } catch (err) { log.warn(`[repair-wsl] bootstrap after repair: ${err.message}`); }
        try { await registerAppTeam(); } catch {}
        try { await maybeStartChromeProxy(); } catch {}
      }
      await refreshDockerStatus().catch(() => {});
      return r;
    } catch (err) { return { ok: false, error: err.message }; }
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
    auditDestructiveIpc(log, "docker:app-recreate", e);
    try {
      await ensureDockerTeam();
      await appDocker.recreate({
        ...(await appOpts()),
        force: true, // 用户在卡片菜单明确点击并 confirm → 放行
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

  // Chrome 代理已无开关:始终开启(chromeProxyEnabled 恒真),二进制在 bootstrap 预下载,
  // 容器装好后自动起 host mihomo,reconcile 自愈。docker:app-chrome-proxy 已移除。

  // ⋯ menu → 更新 cicy-code: pull the latest cicy-code into the container +
  // restart it (no container recreate). Streams progress to the drawer.
  ipcMain.handle("docker:app-update", async (e) => {
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "Docker cicy-code 仅支持 Windows" };
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

  // ⋯ menu → 升级: re-pull the latest R2 image, re-create the :8008 container.
  ipcMain.handle("docker:app-upgrade", async (e) => {
    auditDestructiveIpc(log, "docker:app-upgrade", e);
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "Docker cicy-code 仅支持 Windows" };
    try {
      await ensureDockerTeam();
      const result = await appDocker.upgrade({
        ...(await appOpts()),
        force: true, // 用户显式升级
        onProgress: (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} },
      });
      if (result && result.ok) await registerAppTeam();
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 端口设置:读当前已发布的额外端口(:8008 固定,不在列)。
  // 容器保护开关:开启时任何自动流程都不得 rm/recreate 容器或 wsl --shutdown。
  ipcMain.handle("docker:get-protect", () => ({ ok: true, enabled: dockerProtect.isProtected() }));
  ipcMain.handle("docker:set-protect", (e, on) => {
    auditDestructiveIpc(log, "docker:set-protect", e, { enabled: !!on });
    try { return { ok: true, enabled: dockerProtect.setProtected(!!on) }; } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle("docker:get-ports", () => {
    return { ok: true, mainPort: APP_PORT, ports: readExtraPorts() };
  });
  // 保存端口 → 持久化 → recreate 容器带上新的 -p(:8008 + 各额外端口)。volume 保留。
  ipcMain.handle("docker:set-ports", async (e, input) => {
    auditDestructiveIpc(log, "docker:set-ports", e, { ports: input?.ports });
    if (!APP_DOCKER_SUPPORTED) return { ok: false, error: "Docker cicy-code 仅支持 Windows" };
    const ports = sanitizePorts(input && input.ports);
    writeExtraPorts(ports);
    try {
      await ensureDockerTeam();
      const result = await appDocker.recreate({
        ...(await appOpts()),
        force: true, // 用户显式改端口 // 已含 extraPorts: readExtraPorts()(刚写入的)
        onProgress: (ev) => { try { e.sender.send("docker:app-progress", ev); } catch {} },
      });
      await registerAppTeam();
      return { ok: true, ports, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Start (or reuse) the cicy-code daemon. probeExisting inside start() reuses
  // a healthy :8008; otherwise it spawns `npx cicy-code` / the Docker container.
  ipcMain.handle("sidecar:start", async (e) => {
    // 流式把安装进度推给抽屉("为什么不弹 drawer 显示安装日志,卡在哪我怎么知道"):
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
      // 「进行中」、不翻 error、不出重试按钮 —— 实测的 bug)。
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
      // user isn't left staring at a dead :8008 page (bug report).
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

  // 「局域网访问」开关: 读/写 --public flag。set 后自动重启 cicy-code 让它生效,
  // 全程把进度推到抽屉(op:restart)。
  ipcMain.handle("sidecar:get-public", () => {
    try { return { ok: true, public: sidecar.isPublic() }; } catch (e) { return { ok: false, public: false, error: e.message }; }
  });
  ipcMain.handle("sidecar:set-public", async (e, on) => {
    const emit = (ev) => { try { e.sender.send("sidecar:op-progress", { op: "restart", ...ev }); } catch {} };
    try {
      sidecar.setPublicFlag(!!on);
      emit({ phase: "swap", status: "running", message: `局域网访问已${on ? "开启" : "关闭"},正在重启 cicy-code…` });
      await sidecar.restart({ logPath: sidecarLogPath });
      let up = false;
      for (let i = 0; i < 240; i++) { if (await sidecar.probeExisting(PORT)) { up = true; break; } await new Promise((r) => setTimeout(r, 500)); }
      emit({ phase: "done", status: up ? "done" : "error", message: up ? `cicy-code 已重启(局域网访问${on ? "开" : "关"})` : "重启后 :8008 未就绪——稍等或重试" });
      return { ok: up, public: !!on };
    } catch (err) {
      emit({ phase: "done", status: "error", message: `设置失败:${err.message}` });
      return { ok: false, error: err.message };
    }
  });

  // 账号套餐等级(徽章用)—— 从云端取 tier,忽略 tunnels 列表;与自填隧道解耦。
  ipcMain.handle("tunnel:status", async () => {
    try { return cc ? await cc.listTunnels() : { ok: false, tunnelLimit: 0 }; } catch (e) { return { ok: false, tunnelLimit: 0, error: e.message }; }
  });

  // 「容器内使用 Docker」(Docker-outside-of-Docker)开关: 读/写 dood flag。set 后重建容器
  // 让 docker.sock + WSL 的 docker 客户端挂载生效(runContainer 内部读 dood flag)。
  ipcMain.handle("sidecar:get-dood", () => {
    try { return { ok: true, dood: sidecar.isDood() }; } catch (e) { return { ok: false, dood: false, error: e.message }; }
  });
  ipcMain.handle("sidecar:set-dood", async (e, on) => {
    auditDestructiveIpc(log, "sidecar:set-dood", e, { enabled: !!on });
    const emit = (ev) => { try { e.sender.send("sidecar:op-progress", { op: "restart", ...ev }); } catch {} };
    try {
      sidecar.setDood(!!on);
      emit({ phase: "swap", status: "running", message: `容器 Docker 访问已${on ? "开启" : "关闭"},正在重建容器…` });
      try { await appDocker.recreate({ ...(await appOpts()), force: true, onProgress: emit }); }
      catch (err) { try { await appDocker.dockerRestart?.({ onProgress: emit }); } catch {} }
      let up = false;
      for (let i = 0; i < 240; i++) { if ((await appDocker.probeHealth?.(PORT)) || (await sidecar.probeExisting(PORT))) { up = true; break; } await new Promise((r) => setTimeout(r, 500)); }
      emit({ phase: "done", status: up ? "done" : "error", message: up ? `容器 Docker 访问已${on ? "开启" : "关闭"}` : "重建后 :8008 未就绪——稍等或重试" });
      return { ok: up, dood: !!on };
    } catch (err) {
      emit({ phase: "done", status: "error", message: `设置失败:${err.message}` });
      return { ok: false, error: err.message };
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
