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
const yaml = require("js-yaml");
const { t } = require("../i18n"); // 进度/错误文案 i18n(drawer 里显示)
const tt = (k, o) => t(`chromeProxy.${k}`, o);

const VER = (process.env.CICY_MIHOMO_VERSION || "v1.10.4").replace(/^v?/, "v");
const OSS_BASE = process.env.CICY_OSS_BASE || "https://cicy-1372193042-cn.oss-cn-shanghai.aliyuncs.com";
const IS_WIN = process.platform === "win32";
const EXT = IS_WIN ? ".exe" : "";

function osStr() { return process.platform === "darwin" ? "darwin" : IS_WIN ? "windows" : "linux"; }
function archStr() { return process.arch === "arm64" ? "arm64" : "amd64"; }
// OSS mirror of cicy-ai/cicy-mihomo releases (see mihomo/<ver>/mihomo-<os>-<arch>).
function assetUrl() { return process.env.CICY_MIHOMO_RELEASE_URL || `${OSS_BASE}/mihomo/${VER}/mihomo-${osStr()}-${archStr()}${EXT}`; }

const RT_DIR = path.join(os.homedir(), "cicy-ai", "runtime", "mihomo", VER.replace(/^v/, ""));
function binPath() { return path.join(RT_DIR, "mihomo" + EXT); }
const HOST_CONFIG = path.join(os.homedir(), "cicy-ai", "db", "mihomo-host.yaml");
// Log lives under ~/logs, NOT db/ — db/ holds data + config only (config below
// stays in db/ as mihomo-host.yaml; this is just the runtime log).
const HOST_LOG = path.join(os.homedir(), "logs", "mihomo-host.log");
const PID_FILE = path.join(os.homedir(), "cicy-ai", "db", "mihomo-host.pid");

// Host instance's own control/mixed ports — kept OFF the container's (9001/19001)
// so the two mihomos never clash even if both somehow share a loopback view.
const HOST_MIXED = Number(process.env.CICY_HOST_MIHOMO_MIXED || 9011);
const HOST_CTRL = Number(process.env.CICY_HOST_MIHOMO_CTRL || 19011);

function binPresent() { try { return fs.statSync(binPath()).size > 1_000_000; } catch { return false; } }

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

// Pull the mihomo binary from OSS into the runtime store (idempotent).
async function ensureBinary({ emit } = {}) {
  if (binPresent()) return binPath();
  fs.mkdirSync(RT_DIR, { recursive: true });
  emit && emit({ phase: "chrome-proxy", status: "running", message: tt("downloading") });
  await download(assetUrl(), binPath());
  if (!IS_WIN) { try { fs.chmodSync(binPath(), 0o755); } catch {} }
  if (!binPresent()) throw new Error(tt("verifyFailed"));
  return binPath();
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
async function enable({ containerYaml, emit } = {}) {
  await ensureBinary({ emit });
  if (!containerYaml) throw new Error(tt("noContainerConfig"));
  const changed = writeConfig(containerYaml);
  const res = start({ force: changed });
  emit && emit({ phase: "chrome-proxy", status: "running", message: tt("ready") });
  return { ok: true, ...res };
}

module.exports = {
  VER, assetUrl, binPath, binPresent, ensureBinary,
  buildHostConfig, writeConfig, start, stop, running, enable,
  HOST_CONFIG, HOST_LOG,
};
