// CiCy Desktop 自定义自更新(替掉 electron-updater 的全自动 quitAndInstall —— 它对
// 未签名 mac / loose 源码版 / 多窗口 tab-shell 都不适配)。
//
// 产品流程:启动后比版本 → 有新版 broadcast「available」→ 渲染层顶部 banner「发现新版
// [下载]」→ 用户点下载 → 按平台从对应源下安装包(带进度条)→ broadcast「downloading」
// → 下完「ready」→ 用户点安装 → 拉起原生安装器并退出 app。
//
// 源(分网络 + 分平台):
//   版本清单  CN → OSS releases/latest-version.txt;非 CN → GitHub releases/latest
//   Windows  → OSS  cicy-desktop-<ver>.exe          (GitHub 不发 win 包)
//   macOS    → GitHub cicy-desktop-<ver>-<arch>.pkg (CN 经 ghproxy 兜底)
//   Linux    → GitHub CiCy-Desktop-<ver>.AppImage   (CN 经 ghproxy 兜底)

const { app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const log = require("electron-log");
const { OSS_RELEASES_BASE, MIRRORS, mirrorUrl } = require("./sidecar/mirrors");

const REPO = "cicy-ai/cicy-desktop";
const GH_DL = (ver) => `https://github.com/${REPO}/releases/download/v${ver}`;

// ── 网络判定(缓存)──────────────────────────────────────────────────────────
let _network = null;
async function detectNetwork() {
  if (_network) return _network;
  try { _network = await require("./sidecar/net-detect")(); } catch { _network = "unknown"; }
  return _network;
}

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

// CN 走 ghproxy 兜底(OSS 没有 mac/linux 包)。
function mirrored(githubUrl) {
  const m = MIRRORS[0];
  return m ? mirrorUrl(githubUrl, m) : githubUrl;
}

// ── 最新版本号 ────────────────────────────────────────────────────────────────
async function fetchLatestVersion(network) {
  if (network === "cn") {
    // CN:OSS 版本清单(纯文本 "2.1.200")。
    return (await getText(`${OSS_RELEASES_BASE}/latest-version.txt`)).trim().replace(/^v/, "");
  }
  // 非 CN:GitHub releases/latest 的 tag_name。
  const j = JSON.parse(await getText(`https://api.github.com/repos/${REPO}/releases/latest`));
  return String(j.tag_name || "").trim().replace(/^v/, "");
}

// ── 安装包 URL(分平台 + 分网络)+ 本地文件名 ────────────────────────────────
function assetFor(version, network) {
  const plat = process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (plat === "win32") {
    // win 包只在 OSS(GitHub 不发);CN/非 CN 都用 OSS。
    return { url: `${OSS_RELEASES_BASE}/cicy-desktop-${version}.exe`, file: `cicy-desktop-${version}.exe` };
  }
  if (plat === "darwin") {
    const gh = `${GH_DL(version)}/cicy-desktop-${version}-${arch}.pkg`;
    return { url: network === "cn" ? mirrored(gh) : gh, file: `cicy-desktop-${version}-${arch}.pkg` };
  }
  // linux
  const gh = `${GH_DL(version)}/CiCy-Desktop-${version}.AppImage`;
  return { url: network === "cn" ? mirrored(gh) : gh, file: `CiCy-Desktop-${version}.AppImage` };
}

// ── 下载(带进度,跟随重定向)──────────────────────────────────────────────────
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("too many redirects"));
    const f = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "cicy-desktop" }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        f.close(); try { fs.unlinkSync(dest); } catch {}
        return download(res.headers.location, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { f.close(); try { fs.unlinkSync(dest); } catch {} return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
      let transferred = 0, lastEmit = 0;
      const startT = Date.now();
      let winT = startT, winBytes = 0, bytesPerSec = 0;
      res.on("data", (chunk) => {
        transferred += chunk.length;
        const now = Date.now();
        // 速度按 ~500ms 滑窗算,平滑不抖。
        if (now - winT >= 500) {
          bytesPerSec = (transferred - winBytes) / ((now - winT) / 1000);
          winT = now; winBytes = transferred;
        }
        // 节流:每 ~120ms 或下载完才推一次(够顺滑又不刷爆 IPC)。
        if (now - lastEmit >= 120 || transferred === total) {
          lastEmit = now;
          const percent = total ? Math.min(100, Math.floor((transferred / total) * 100)) : 0;
          const etaSec = bytesPerSec > 0 && total ? Math.max(0, Math.round((total - transferred) / bytesPerSec)) : 0;
          try { onProgress && onProgress({ percent, transferred, total, bytesPerSec, etaSec }); } catch {}
        }
      });
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve()));
      f.on("error", (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on("error", (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ── 状态机 + 广播 ─────────────────────────────────────────────────────────────
let _win = null;
let _state = { status: "idle", version: null, current: null, progress: null, filePath: null, error: null };
let _downloading = false;

function broadcast(patch) {
  Object.assign(_state, patch);
  try { if (_win && !_win.isDestroyed()) _win.webContents.send("app:update-state", _state); } catch {}
}
function getState() { return _state; }

function init(mainWin) {
  _win = mainWin;
  _state.current = app.getVersion();
  setTimeout(() => check().catch(() => {}), 15_000);      // 启动后探一次
  setInterval(() => check().catch(() => {}), 30 * 60 * 1000); // 每 30 分钟
}

// 比版本;有新版 → available,否则 up-to-date。不自动下载(等用户点)。
async function check() {
  try {
    broadcast({ status: "checking", error: null });
    const net = await detectNetwork();
    const latest = await fetchLatestVersion(net);
    const current = app.getVersion();
    if (latest && cmpVer(latest, current) > 0) {
      broadcast({ status: "available", version: latest, current, progress: null, filePath: null });
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
    const net = await detectNetwork();
    const { url, file } = assetFor(version, net);
    // 下到 ~/Downloads(用户能直接找到安装包);目录不存在则建。
    const dir = app.getPath("downloads");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const dest = path.join(dir, file);
    log.info(`[app-updater] downloading ${url} → ${dest}`);
    broadcast({ status: "downloading", progress: { percent: 0, transferred: 0, total: 0 }, filePath: null });
    await download(url, dest, (p) => broadcast({ status: "downloading", progress: p }));
    broadcast({ status: "ready", filePath: dest, progress: { percent: 100 } });
    return _state;
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

module.exports = { init, check, getState, downloadUpdate, installNow };
