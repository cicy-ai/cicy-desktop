// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Host-side mihomo for the Chrome per-profile proxy.
//
// docker-only put mihomo INSIDE the cicy-code container. But the system Chrome
// runs on the HOST (mac/win/linux), and its per-profile proxy points at
// 127.0.0.1:2000N — which a container CANNOT reliably serve through colima/WSL
// port-forwarding (the per-profile listeners bind 127.0.0.1 inside the container;
// publishing the 20001-32 range through colima/Lima never reached them → Chrome
// got ERR_EMPTY_RESPONSE / connection-closed). 方案: run a SECOND mihomo on
// the HOST, reusing the SAME proxy nodes/rules — we copy the container's
// mihomo.yaml out (the cloud provisions it with the real upstream nodes), strip
// it down to just what Chrome needs (listeners + proxies + groups + rules), and
// run it natively so Chrome reaches 127.0.0.1:2000N directly. No container port
// publish involved (runContainer drops the -p 20001-32 range).
//
// Binary is pulled from OSS (CN-fast) — github/gh-proxy was too slow on real
// Macs. Same version the container uses (cicy-ai/cicy-mihomo v1.10.4).

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const yaml = require("js-yaml");
const { t } = require("../i18n"); // 进度/错误文案 i18n(drawer 里显示)
const tt = (k, o) => t(`chromeProxy.${k}`, o);

const VER = (process.env.CICY_MIHOMO_VERSION || "v1.10.4").replace(/^v?/, "v");
const R2_BASE = process.env.CICY_R2_BASE || process.env.CICY_OSS_BASE || "https://r2.deepfetch.de5.net";
const IS_WIN = process.platform === "win32";
const EXT = IS_WIN ? ".exe" : "";

function osStr() { return process.platform === "darwin" ? "darwin" : IS_WIN ? "windows" : "linux"; }
function archStr() { return process.arch === "arm64" ? "arm64" : "amd64"; }
// R2 mirror of cicy-ai/cicy-mihomo releases (see mihomo/<ver>/mihomo-<os>-<arch>).
function assetUrl() { return process.env.CICY_MIHOMO_RELEASE_URL || `${R2_BASE}/mihomo/${VER}/mihomo-${osStr()}-${archStr()}${EXT}`; }

// Store under ~/.local/bin like cicy-code / cicy-mihomo — never ~/cicy-ai/runtime
// anymore. Old runtime-store copies still RESOLVE (read-only compat) so an
// existing install isn't re-downloaded; ensureBinary migrates them in.
const VERD = VER.replace(/^v/, "");
const LOCAL_BIN = path.join(os.homedir(), ".local", "bin");
const NEW_BIN = path.join(LOCAL_BIN, `mihomo-${VERD}${EXT}`);
const LINK = path.join(LOCAL_BIN, `mihomo${EXT}`);
const LEGACY_BIN = path.join(os.homedir(), "cicy-ai", "runtime", "mihomo", VERD, "mihomo" + EXT);
function valid(p) { try { return fs.statSync(p).size > 1_000_000; } catch { return false; } }
// resolve: ~/.local/bin versioned file first, legacy runtime store as fallback.
function binPath() { return valid(NEW_BIN) ? NEW_BIN : valid(LEGACY_BIN) ? LEGACY_BIN : NEW_BIN; }
// ~/.local/bin/mihomo → versioned file. We exec via the absolute versioned path,
// so this symlink is only a PATH convenience — create it only when absent, never
// clobber one that runtime.js / cicy-mihomo already points at their version.
function ensureLink() {
  try {
    if (!valid(NEW_BIN) || fs.existsSync(LINK)) return;
    if (IS_WIN) { fs.copyFileSync(NEW_BIN, LINK); return; }
    fs.symlinkSync(NEW_BIN, LINK);
  } catch {}
}
const HOST_CONFIG = path.join(os.homedir(), "cicy-ai", "db", "mihomo-host.yaml");
// Log lives under ~/logs, NOT db/ — db/ holds data + config only (config below
// stays in db/ as mihomo-host.yaml; this is just the runtime log).
const HOST_LOG = path.join(os.homedir(), "logs", "mihomo-host.log");
const PID_FILE = path.join(os.homedir(), "cicy-ai", "db", "mihomo-host.pid");

// Host instance's own control/mixed ports — kept OFF the container's (9001/19001)
// so the two mihomos never clash even if both somehow share a loopback view.
const HOST_MIXED = Number(process.env.CICY_HOST_MIHOMO_MIXED || 9011);
const HOST_CTRL = Number(process.env.CICY_HOST_MIHOMO_CTRL || 19011);

function binPresent() { return valid(NEW_BIN) || valid(LEGACY_BIN); }

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const f = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        f.close(); try { fs.unlinkSync(dest); } catch {}
        return download(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { f.close(); try { fs.unlinkSync(dest); } catch {} return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve()));
      f.on("error", (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
    req.on("error", (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

// Ensure the mihomo binary is in ~/.local/bin/mihomo-<ver> (idempotent).
// Already there → done. Only a legacy runtime copy → migrate it (no network).
// Nothing → pull from OSS.
async function ensureBinary({ emit } = {}) {
  if (valid(NEW_BIN)) { ensureLink(); return NEW_BIN; }
  fs.mkdirSync(LOCAL_BIN, { recursive: true });
  if (valid(LEGACY_BIN)) {
    // atomic: stage then rename, so an interrupted copy never leaves a partial
    // NEW_BIN that valid() would later mistake for a good binary.
    const stg = NEW_BIN + ".mig";
    try { fs.copyFileSync(LEGACY_BIN, stg); if (!IS_WIN) fs.chmodSync(stg, 0o755); fs.renameSync(stg, NEW_BIN); }
    catch { try { fs.rmSync(stg, { force: true }); } catch {} }
    if (valid(NEW_BIN)) { ensureLink(); return NEW_BIN; }
  }
  emit && emit({ phase: "chrome-proxy", status: "running", message: tt("downloading") });
  await download(assetUrl(), NEW_BIN);
  if (!IS_WIN) { try { fs.chmodSync(NEW_BIN, 0o755); } catch {} }
  if (!valid(NEW_BIN)) throw new Error(tt("verifyFailed"));
  ensureLink();
  return NEW_BIN;
}

// Build the HOST config from the container's mihomo.yaml: keep only what Chrome
// needs (listeners + proxies + proxy-groups + rules), disable DNS (no :53 bind on
// the host — needs root) and pin our own control/mixed ports. The per-profile
// listeners already bind 127.0.0.1, exactly what host Chrome connects to.
function buildHostConfig(containerYaml) {
  let c = {};
  try { c = yaml.load(containerYaml) || {}; } catch (e) { throw new Error(tt("containerConfigParseFailed", { err: e.message })); }
  const host = {
    "mixed-port": HOST_MIXED,
    "allow-lan": false,
    "log-level": "warning",
    "external-controller": `127.0.0.1:${HOST_CTRL}`,
    secret: "",
    dns: { enable: false },
    listeners: Array.isArray(c.listeners) ? c.listeners : [],
    proxies: Array.isArray(c.proxies) ? c.proxies : [],
    "proxy-groups": Array.isArray(c["proxy-groups"]) ? c["proxy-groups"] : [],
    rules: Array.isArray(c.rules) ? c.rules : ["MATCH,DIRECT"],
  };
  return yaml.dump(host, { lineWidth: -1 });
}

// Write the adapted config; returns true if it changed (caller restarts on change).
function writeConfig(containerYaml) {
  const next = buildHostConfig(containerYaml);
  let prev = ""; try { prev = fs.readFileSync(HOST_CONFIG, "utf8"); } catch {}
  fs.mkdirSync(path.dirname(HOST_CONFIG), { recursive: true });
  if (prev === next) return false;
  fs.writeFileSync(HOST_CONFIG, next);
  return true;
}

function readPid() { try { return Number(fs.readFileSync(PID_FILE, "utf8").trim()) || 0; } catch { return 0; } }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function running() { return alive(readPid()); }

function planSelectionUpdates(hostSnapshot, authoritativeSelections) {
  const hostProxies = hostSnapshot && hostSnapshot.proxies;
  if (!hostProxies || typeof hostProxies !== "object") return [];
  const updates = [];
  for (const [group, target] of Object.entries(authoritativeSelections || {})) {
    const current = hostProxies[group];
    if (!current || current.type !== "Selector" || !Array.isArray(current.all)) continue;
    if (!current.all.includes(target) || current.now === target) continue;
    updates.push({ group, from: current.now || "", to: target });
  }
  return updates;
}

function controllerRequest(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const encoded = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: "127.0.0.1", port: HOST_CTRL, method, path: pathname,
      headers: encoded ? { "Content-Type": "application/json", "Content-Length": encoded.length } : {},
      timeout: 3000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`host mihomo controller HTTP ${res.statusCode}: ${text}`));
          return;
        }
        if (!text) { resolve({}); return; }
        try { resolve(JSON.parse(text)); } catch { reject(new Error("invalid host mihomo controller response")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("host mihomo controller timeout")));
    req.on("error", reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

async function syncSelections(authoritativeSelections = {}) {
  let snapshot;
  let lastError;
  // A forced config restart briefly closes the controller; wait for it to return.
  for (let attempt = 0; attempt < 8; attempt++) {
    try { snapshot = await controllerRequest("GET", "/proxies"); break; }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!snapshot) throw lastError || new Error("host mihomo controller unavailable");
  const updates = planSelectionUpdates(snapshot, authoritativeSelections);
  for (const update of updates) {
    await controllerRequest(
      "PUT",
      `/proxies/${encodeURIComponent(update.group)}`,
      { name: update.to },
    );
  }
  return { updated: updates };
}

function stop() {
  const pid = readPid();
  if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// Spawn the host mihomo detached so it survives this process. Idempotent: a live
// instance with the current config is left alone unless force.
function start({ force = false } = {}) {
  if (!force && running()) return { started: false, adopted: true };
  stop();
  if (!binPresent()) throw new Error(tt("binMissing"));
  if (!fs.existsSync(HOST_CONFIG)) throw new Error(tt("configMissing"));
  fs.mkdirSync(path.dirname(HOST_LOG), { recursive: true }); // ~/logs may not exist yet
  const out = fs.openSync(HOST_LOG, "a");
  const child = spawn(binPath(), ["-f", HOST_CONFIG], {
    detached: true, stdio: ["ignore", out, out], windowsHide: true,
  });
  child.unref();
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch {}
  return { started: true, pid: child.pid };
}

// Full enable: ensure binary → copy+adapt container config → (re)start.
// containerYaml is fetched by the caller (sidecar-ipc) via appDocker.
// A missing container config is NOT fatal on its own: when the WSL/docker
// cicy-code isn't installed (or is down) we run STANDALONE on the host's own
// mihomo-host.yaml if one is already there, so the per-profile proxies keep
// working instead of dying with the container — that's what lets Windows run
// without WSL at all. Only "no container config AND no host config" leaves us
// nothing to start. Standalone has no authoritative selection source, so the
// selection sync is skipped rather than overriding whatever the host holds.
async function enable({ containerYaml, selections = {}, emit } = {}) {
  await ensureBinary({ emit });
  let changed = false, standalone = false;
  if (containerYaml) changed = writeConfig(containerYaml);
  else if (fs.existsSync(HOST_CONFIG)) standalone = true;
  else throw new Error(tt("noContainerConfig"));
  const res = start({ force: changed });
  const synced = standalone ? { updated: [] } : await syncSelections(selections);
  emit && emit({ phase: "chrome-proxy", status: "running", message: tt("ready") });
  return { ok: true, standalone, ...res, ...synced };
}

module.exports = {
  VER, assetUrl, binPath, binPresent, ensureBinary,
  buildHostConfig, writeConfig, planSelectionUpdates, syncSelections,
  start, stop, running, enable,
  HOST_CONFIG, HOST_LOG,
};
