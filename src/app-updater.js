// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// CiCy Desktop 自定义自更新(替掉 electron-updater 的全自动 quitAndInstall —— 它对
// 未签名 mac / loose 源码版 / 多窗口 tab-shell 都不适配)。
//
// 产品流程:启动后比版本 → 有新版 broadcast「available」→ 渲染层顶部 banner「发现新版
// [下载]」→ 用户点下载 → 按平台从对应源下安装包(带进度条)→ broadcast「downloading」
// → 下完「ready」→ 用户点安装 → 拉起原生安装器并退出 app。
//
// 源(分网络 + 分平台):
//   版本清单  CN → OSS releases/{win,mac}-latest-version.txt(按平台);非 CN → GitHub releases/latest
//   Windows  → OSS  cicy-desktop-<ver>.exe          (GitHub 不发 win 包)
//   macOS    → GitHub cicy-desktop-<ver>-<arch>.pkg (CN 经 ghproxy 兜底)
//   Linux    → GitHub CiCy-Desktop-<ver>.AppImage   (CN 经 ghproxy 兜底)

const { app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { readGlobalConfig, updateGlobalConfig } = require("./utils/global-json");
const https = require("https");
const log = require("electron-log");
const { R2_RELEASES_BASE, buildUrlList } = require("./sidecar/mirrors");

// ── 版本比较:>0 a 新于 b ─────────────────────────────────────────────────────
function cmpVer(a, b) {
  const pa = String(a || "0").replace(/^v/, "").split(".");
  const pb = String(b || "0").replace(/^v/, "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 小工具:GET 文本(跟随重定向)
function getText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const req = https.get(url, { headers: { "User-Agent": "cicy-desktop" }, timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return getText(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let s = ""; res.setEncoding("utf8");
      res.on("data", (d) => (s += d));
      res.on("end", () => resolve(s));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// HEAD 探测 URL 是否可下(200/206 = ok)。跟随重定向(GitHub release 会 302 到 CDN)。
// 用于「先出包再更新版本」的客户端保险:版本号涨了但包还没传 → HEAD 404 → 先不报更新。
function headOk(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 6) return resolve(false);
    let req;
    try {
      req = https.request(url, { method: "HEAD", headers: { "User-Agent": "cicy-desktop" }, timeout: 10000 }, (res) => {
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return headOk(res.headers.location, redirects + 1).then(resolve);
        }
        resolve(res.statusCode === 200 || res.statusCode === 206);
      });
    } catch { return resolve(false); }
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── 最新版本号 ────────────────────────────────────────────────────────────────
// R2 优先(win/mac/linux 各自指针,两条 CI 版本可能不同步,所以各读各的),GitHub 兜底。
//
// 原先这里是「一律读 OSS,彻底不碰 GitHub」,理由是仓库可能私有。代价是 R2 一旦不可达,
// 自更新就整条断掉 —— 而 fleet 里确实有一批 Windows 节点连 r2.deepfetch.de5.net 直接
// ECONNRESET(GitHub 反而 ~300ms 可达),它们因此永远停在旧版、只能人工推包。
// 现在 R2 仍是首选(仓库若再转私有,这条路不受影响),失败才回退 GitHub Release;
// 两边都不通才算真失败。
const GH_REPO = "cicy-ai/cicy-desktop";

function fetchLatestVersionFromGitHub() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${GH_REPO}/releases/latest`,
      { headers: { "User-Agent": "cicy-desktop-updater", Accept: "application/vnd.github+json" }, timeout: 10000 },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub HTTP ${res.statusCode}`)); }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const tag = String((JSON.parse(body) || {}).tag_name || "").replace(/^v/, "");
            tag ? resolve(tag) : reject(new Error("no tag_name"));
          } catch (e) { reject(e); }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function fetchLatestVersion() {
  const file = process.platform === "win32" ? "win-latest-version.txt"
    : process.platform === "darwin" ? "mac-latest-version.txt"
    : "linux-latest-version.txt";
  try {
    return (await getText(`${R2_RELEASES_BASE}/${file}`)).trim().replace(/^v/, "");
  } catch (e) {
    log.warn(`[app-updater] R2 版本指针不可达(${e.message}),回退 GitHub Release`);
    return await fetchLatestVersionFromGitHub();
  }
}

// ── 安装包来源(有序候选)+ 本地文件名 ──────────────────────────────────────
// 返回 { file, urls } —— urls 是按优先级排好的候选:R2 → GitHub 直连 → ghproxy 镜像。
// 调用方依次尝试,第一个能下的算数(见 check() 的 HEAD 探测和 downloadUpdate 的重试)。
//
// 注意 Windows 两边**文件名不同**:R2 上是 cicy-desktop-<ver>.exe(CI 传的版本化副本),
// GitHub Release 里是 electron-builder 产出的 CiCy-Desktop-Setup-<ver>.exe。
// mac 的 pkg 和 linux 的 AppImage 两边同名。`file` 只是本地落盘名,保持原样不变。
function assetFor(version) {
  const plat = process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const file = plat === "win32" ? `cicy-desktop-${version}.exe`
    : plat === "darwin" ? `cicy-desktop-${version}-${arch}.pkg`
    : `CiCy-Desktop-${version}.AppImage`;
  const ghName = plat === "win32" ? `CiCy-Desktop-Setup-${version}.exe` : file;
  const ghUrl = `https://github.com/${GH_REPO}/releases/download/v${version}/${ghName}`;
  // buildUrlList("global") = [直连, ...镜像];R2 排在最前面。
  const urls = [`${R2_RELEASES_BASE}/${file}`, ...buildUrlList(ghUrl, "global")];
  return { file, urls, url: urls[0] };
}

// 第一个 HEAD 得到 200/206 的候选;都不行返回 null。
async function firstReachable(urls) {
  for (const u of urls) {
    if (await headOk(u)) return u;
  }
  return null;
}

// ── 下载(带进度、跟随重定向、断点续传)────────────────────────────────────
// A single https.get with a 30s socket timeout used to BE the download: one
// stall on a slow mirror and the update failed for good. That is not
// theoretical — a fleet node sat on an old build for several releases with
// "download failed: timeout" every 30 minutes, because its link to the CDN
// could serve ranges fine but never sustained the whole 125MB inside one
// socket. So: retry, and resume from what already landed instead of starting
// over. A slow link now takes several passes and still finishes.
function downloadOnce(url, dest, onProgress, startAt, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("too many redirects"));
    const headers = { "User-Agent": "cicy-desktop" };
    if (startAt > 0) headers.Range = `bytes=${startAt}-`;
    const req = https.get(url, { headers, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadOnce(res.headers.location, dest, onProgress, startAt, redirects + 1).then(resolve, reject);
      }
      // 206 = the server honoured the range → append. 200 with startAt means it
      // ignored it → start the file over rather than corrupt it by appending.
      const resuming = res.statusCode === 206;
      if (res.statusCode !== 200 && !resuming) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const base = resuming ? startAt : 0;
      const f = fs.createWriteStream(dest, resuming ? { flags: "a" } : {});
      const len = parseInt(res.headers["content-length"] || "0", 10) || 0;
      const total = base + len;
      let transferred = base, lastEmit = 0;
      const startT = Date.now();
      let winT = startT, winBytes = transferred, bytesPerSec = 0;
      res.on("data", (chunk) => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - winT >= 500) {
          bytesPerSec = (transferred - winBytes) / ((now - winT) / 1000);
          winT = now; winBytes = transferred;
        }
        if (now - lastEmit >= 120 || transferred === total) {
          lastEmit = now;
          const percent = total ? Math.min(100, Math.floor((transferred / total) * 100)) : 0;
          const etaSec = bytesPerSec > 0 && total ? Math.max(0, Math.round((total - transferred) / bytesPerSec)) : 0;
          try { onProgress && onProgress({ percent, transferred, total, bytesPerSec, etaSec }); } catch {}
        }
      });
      res.on("error", (e) => { f.close(); reject(e); });
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve({ transferred, total })));
      f.on("error", (e) => reject(e));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

const DOWNLOAD_ATTEMPTS = 6;

async function download(url, dest, onProgress) {
  let lastErr = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    let have = 0;
    try { have = fs.statSync(dest).size; } catch {}
    try {
      const r = await downloadOnce(url, dest, onProgress, have);
      // A truncated body that ends cleanly still resolves, so only stop when the
      // file is actually as long as the server said.
      if (!r.total || r.transferred >= r.total) return;
      lastErr = new Error(`short read ${r.transferred}/${r.total}`);
    } catch (e) {
      lastErr = e;
    }
    let now = 0;
    try { now = fs.statSync(dest).size; } catch {}
    log.warn(`[app-updater] download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed (${lastErr.message}); have ${now} bytes`);
    if (now <= have && attempt > 1) {
      // two passes in a row moved nothing — the source is not just slow.
      try { fs.unlinkSync(dest); } catch {}
    }
  }
  throw lastErr || new Error("download failed");
}

// ── 状态机 + 广播 ─────────────────────────────────────────────────────────────
let _win = null;
let _state = { status: "idle", version: null, current: null, progress: null, filePath: null, error: null, autoUpdate: false, auto: false };
let _downloading = false;

// 「以后自动更新到最新版」开关,存 ~/cicy-ai/global.json desktopAutoUpdate(设备级,与账号无关)。
// 打开后 check() 发现新版直接下载 + 拉起安装器,不再弹「发现新版本」询问。
const GLOBAL_JSON = path.join(os.homedir(), "cicy-ai", "global.json");
function getAutoUpdate() {
  // 默认开启(未设置视为开):机群里的旧版本要能自己收敛到最新版,不能靠人一台台推;
  // 更新弹窗里取消勾选即关闭(写 false)。
  try { return readGlobalConfig(GLOBAL_JSON)?.desktopAutoUpdate !== false; } catch { return true; }
}
function setAutoUpdate(on) {
  const v = on === true;
  try { updateGlobalConfig(GLOBAL_JSON, (c) => ({ ...(c || {}), desktopAutoUpdate: v })); }
  catch (e) { log.warn("[app-updater] setAutoUpdate failed:", e.message); }
  broadcast({ autoUpdate: v });
  return v;
}

function broadcast(patch) {
  Object.assign(_state, patch);
  try { if (_win && !_win.isDestroyed()) _win.webContents.send("app:update-state", _state); } catch {}
}
function getState() { return _state; }

function init(mainWin) {
  _win = mainWin;
  _state.current = app.getVersion();
  _state.autoUpdate = getAutoUpdate();
  setTimeout(() => check().catch(() => {}), 15_000);      // 启动后探一次
  setInterval(() => check().catch(() => {}), 30 * 60 * 1000); // 每 30 分钟
}

// 比版本;有新版 → available,否则 up-to-date。不自动下载(等用户点)。
async function check() {
  try {
    broadcast({ status: "checking", error: null });
    const latest = await fetchLatestVersion();
    const current = app.getVersion();
    if (latest && cmpVer(latest, current) > 0) {
      // 「先出包再更新版本」客户端保险:版本号涨了不代表包传完了。先 HEAD 确认本平台安装包
      // 真能下(200),否则当成「还没就绪」继续显已是最新,避免用户点下载 404。
      const { urls } = assetFor(latest);
      const ready = await firstReachable(urls);
      if (ready) {
        log.info(`[app-updater] ${latest} 安装包就绪:${ready}`);
        broadcast({ status: "available", version: latest, current, progress: null, filePath: null, autoUpdate: getAutoUpdate(), auto: false });
        if (getAutoUpdate()) {
          log.info(`[app-updater] auto-update on → downloading ${latest} and installing without asking`);
          broadcast({ auto: true });
          await downloadUpdate();
          if (_state.status === "ready") installNow();
        }
      } else { log.info(`[app-updater] ${latest} 版本号已更新但所有来源都拿不到安装包(HEAD 非 200):${urls.join(" , ")} — 暂不提示更新`); broadcast({ status: "up-to-date", version: current, current }); }
    } else {
      broadcast({ status: "up-to-date", version: latest || current, current });
    }
    return _state;
  } catch (e) {
    log.warn("[app-updater] check failed:", e.message);
    broadcast({ status: "error", error: e.message });
    return _state;
  }
}

// 用户点「下载」:按平台 + 网络下安装包到临时目录,带进度。
async function downloadUpdate() {
  if (_downloading) return _state;
  const version = _state.version;
  if (!version) { broadcast({ status: "error", error: "no version" }); return _state; }
  _downloading = true;
  try {
    const { urls, file } = assetFor(version);
    // 下到 ~/Downloads(用户能直接找到安装包);目录不存在则建。
    const dir = app.getPath("downloads");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const dest = path.join(dir, file);
    broadcast({ status: "downloading", progress: { percent: 0, transferred: 0, total: 0 }, filePath: null });
    // 逐个候选试(R2 → GitHub → 镜像):一个源断了就换下一个,全断才算失败。
    let lastErr = null;
    for (const url of urls) {
      // Resume is per-SOURCE. The candidates are the same artifact today (CI
      // uploads one exe under two names), but appending bytes from a second host
      // onto a partial from the first would silently produce a corrupt installer
      // the moment that stops being true — and nothing here verifies a hash
      // before running it. Start each source from zero.
      try { fs.unlinkSync(dest); } catch {}
      try {
        log.info(`[app-updater] downloading ${url} → ${dest}`);
        await download(url, dest, (p) => broadcast({ status: "downloading", progress: p }));
        broadcast({ status: "ready", filePath: dest, progress: { percent: 100 } });
        return _state;
      } catch (e) {
        lastErr = e;
        log.warn(`[app-updater] 源失败(${url}):${e.message}`);
      }
    }
    throw lastErr || new Error("no source available");
  } catch (e) {
    log.warn("[app-updater] download failed:", e.message);
    broadcast({ status: "error", error: e.message });
    return _state;
  } finally {
    _downloading = false;
  }
}

// 用户点「安装」:拉起原生安装器(win NSIS / mac pkg)并退出 app;linux AppImage 在
// 文件管理器里定位(AppImage 非安装器,用户自行替换运行)。
function installNow() {
  const f = _state.filePath;
  if (!f) return;
  try {
    if (process.platform === "linux") { shell.showItemInFolder(f); return; }
    shell.openPath(f).then((err) => {
      if (err) log.warn("[app-updater] openPath failed:", err);
      else setTimeout(() => { try { app.quit(); } catch {} }, 800);
    });
  } catch (e) { log.warn("[app-updater] install failed:", e.message); }
}

module.exports = { init, check, getState, downloadUpdate, installNow, getAutoUpdate, setAutoUpdate };
