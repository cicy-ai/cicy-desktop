// WSL2 integration for Windows hosts. cicy-code is POSIX-only (pty/tmux),
// so on Windows we run the linux-amd64 binary inside WSL2. This module owns
// every WSL-touching shell command in one place; the rest of the codebase
// treats WSL as a second host.
//
// Network-wise, WSL2 forwards `localhost:<port>` from the WSL distro to the
// Windows host automatically, so the homepage's :8008 health checks work
// without any special routing on our side.
//
// CN networks: download retries use ghproxy mirrors before falling back to
// direct github.com — same strategy as installer.js but executed inside the
// WSL distro (so it uses the distro's network stack, not the Windows host's).

const { execFile } = require("child_process");
const log = require("electron-log");

// Cached usable distro — resolved on first call to resolveUsableDistro().
// Reset to null to invalidate (e.g. after running `wsl --install`).
let _cachedUsableDistro = null;

// ---- helpers ----

// Run an arbitrary command via `wsl <args>`. Returns { ok, stdout, stderr, code }.
// Never throws — callers branch on `ok`.
function wslRun(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile("wsl", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
        code: err ? (err.code ?? 1) : 0,
        error: err ? err.message : null,
      });
    });
  });
}

// Run a bash script inside a specific WSL distro. Wraps in `bash -lc` so
// .bashrc/.profile is loaded (PATH, etc.). Distro must be a Linux user
// distro — NOT docker-desktop, which lacks bash/coreutils.
function wslBash(script, opts = {}) {
  const { distro, ...rest } = opts;
  const args = distro ? ["-d", distro, "bash", "-lc", script] : ["bash", "-lc", script];
  return wslRun(args, rest);
}

// Distros installed only as Docker Desktop's WSL backends. They lack a real
// userspace (no bash/curl/cp), so we must never target them when running
// installer/start scripts.
const DOCKER_INTERNAL_DISTROS = new Set([
  "docker-desktop",
  "docker-desktop-data",
  "docker-desktop-bootstrap",
]);

// Distro names we know are full Linux userspaces. First match wins.
const PREFERRED_DISTROS = [
  "Ubuntu",
  "Ubuntu-24.04",
  "Ubuntu-22.04",
  "Ubuntu-20.04",
  "Debian",
];

// Pick a usable distro from a parsed list. Prefer a known full Linux distro
// over the WSL default if the default is one of Docker's internal distros.
function pickUsableDistro(distros) {
  // Prefer: explicit known names → any non-docker distro → null
  for (const name of PREFERRED_DISTROS) {
    const found = distros.find(d => d.name.toLowerCase() === name.toLowerCase());
    if (found) return found.name;
  }
  const general = distros.find(d => !DOCKER_INTERNAL_DISTROS.has(d.name.toLowerCase()));
  return general ? general.name : null;
}

// ---- status ----

// Detect WSL availability. Returns:
//   { installed: false }                       — wsl.exe not present
//   { installed: true, hasDistro: false }      — wsl installed but no distro
//   { installed: true, hasDistro: true,
//     distros: [{name,state,version}],
//     defaultDistro: "docker-desktop",         — what `*` points at (may be unusable)
//     usableDistro:  "Ubuntu",                 — what we'll actually run cicy-code in
//     version: "WSL2" }
async function checkStatus() {
  const status = await wslRun(["--status"], { timeoutMs: 5000 });
  if (!status.ok) return { installed: false };

  const list = await wslRun(["-l", "-v"], { timeoutMs: 5000 });
  if (!list.ok || !list.stdout) return { installed: true, hasDistro: false };

  // Parse all distro entries. Format:
  //   NAME           STATE     VERSION
  //   * Ubuntu       Running   2
  //     docker-desktop Stopped 2
  // wsl emits UTF-16-encoded text; strip null bytes and split.
  const lines = list.stdout.replace(/\u0000/g, "").split(/\r?\n/).filter(Boolean);
  const distros = [];
  let defaultDistro = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.toUpperCase().startsWith("NAME")) continue;
    const isDefault = raw.trimStart().startsWith("*");
    const stripped = raw.replace(/^\s*\*\s*/, "").trim();
    const parts = stripped.split(/\s+/);
    if (parts.length < 3) continue;
    const [name, state, version] = parts;
    distros.push({ name, state, version });
    if (isDefault) defaultDistro = name;
  }

  if (distros.length === 0) return { installed: true, hasDistro: false };

  const usableDistro = pickUsableDistro(distros);
  return {
    installed: true,
    hasDistro: usableDistro !== null,  // false if only docker-desktop present
    distros,
    defaultDistro,
    distro: usableDistro || defaultDistro,  // back-compat: `distro` = preferred
    usableDistro,
    version: distros.find(d => d.name === (usableDistro || defaultDistro))?.version === "2" ? "WSL2" : "WSL1",
  };
}

// ---- install commands ----

// Run a wsl command and stream stdout/stderr lines to onLine. Used by the
// long-running --install flow so the UI can show real-time progress.
function wslSpawn(args, { onLine, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const child = spawn("wsl", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, timeoutMs);

    const handle = (buf, isErr) => {
      // wsl.exe emits UTF-16LE on Windows. Strip null bytes for ASCII parsing.
      const s = String(buf).replace(/\u0000/g, "");
      if (isErr) stderr += s; else stdout += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim() && onLine) {
          try { onLine(line.trim()); } catch {}
        }
      }
    };
    child.stdout.on("data", b => handle(b, false));
    child.stderr.on("data", b => handle(b, true));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, stdout, stderr }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Install WSL2 kernel + Ubuntu distro in one shot.
//
// Strategy:
//   1. CN or unknown network → try `wsl --install --web-download` first.
//      This bypasses Microsoft Store (often slow/unreachable from CN) and
//      pulls the distro tarball from GitHub instead, which is reachable
//      via ghproxy mirrors at the network layer.
//   2. Fall back to plain `wsl --install` (Microsoft Store path) if
//      web-download fails — e.g. on older Windows 10 where the flag is
//      not supported.
//
// `--no-launch` skips the interactive "create UNIX user" wizard so we can
// install non-interactively. The user can launch the distro later if they
// want to set up a non-default username; cicy-code itself just runs as the
// distro's default user.
//
// Requires Administrator privileges. If the user isn't elevated, Windows
// will pop a UAC prompt; if they decline, exit code is 740 / "elevation".
async function installWsl({ network = "unknown", onProgress } = {}) {
  const emit = (e) => { try { onProgress && onProgress(e); } catch {} };
  const onLine = (line) => emit({ phase: "wsl-installing", message: line });

  // CN-first: web-download avoids Microsoft Store and is faster in CN since
  // GitHub-hosted distro tarballs are mirror-able.
  const preferWebDownload = network === "cn" || network === "unknown";

  if (preferWebDownload) {
    log.info("[wsl] trying: wsl --install --web-download --no-launch -d Ubuntu");
    emit({ phase: "wsl-installing", message: "正在通过网络下载安装 WSL2 + Ubuntu…" });
    const r = await wslSpawn(["--install", "--web-download", "--no-launch", "-d", "Ubuntu"], { onLine });
    if (r.ok) {
      log.info("[wsl] installed via web-download");
      return { ok: true, method: "web-download" };
    }
    log.warn(`[wsl] web-download failed (code=${r.code}): ${r.stderr}`);
    // Fall through to Microsoft Store path
  }

  log.info("[wsl] trying: wsl --install --no-launch -d Ubuntu");
  emit({ phase: "wsl-installing", message: "正在通过 Microsoft Store 安装 WSL2 + Ubuntu…" });
  const r = await wslSpawn(["--install", "--no-launch", "-d", "Ubuntu"], { onLine });
  if (r.ok) {
    log.info("[wsl] installed via store");
    return { ok: true, method: "store" };
  }

  log.warn(`[wsl] install failed (code=${r.code}): ${r.stderr}`);
  return {
    ok: false,
    code: r.code,
    error: r.stderr || `wsl --install exit ${r.code}`,
    needElevation: r.code === 740 || /elevat|administrat|denied/i.test(r.stderr || ""),
  };
}

// One-click Windows setup: WSL → Ubuntu → cicy-code in a single flow.
// The caller passes a host-side staged binary; we install WSL if needed,
// wait until the distro is ready, then copy in the binary.
//
// "Has WSL" alone is not enough — Docker Desktop's `docker-desktop` distro
// does not have a real Linux userspace. We require an actual Linux distro
// (Ubuntu/Debian/etc.) and trigger one-click install of Ubuntu otherwise.
async function setupAll({ network, hostStagePath, version, onProgress }) {
  const emit = (e) => { try { onProgress && onProgress(e); } catch {} };

  emit({ phase: "checking-wsl", message: "检查 WSL 状态…" });
  let status = await checkStatus();

  // Trigger install if WSL absent OR no Linux distro is usable (only docker-desktop).
  if (!status.installed || !status.usableDistro) {
    const reason = !status.installed
      ? "WSL2 未安装"
      : "已装 WSL 但缺少 Linux 发行版（只有 docker-desktop）";
    emit({ phase: "installing-wsl", message: `${reason} — 正在安装 Ubuntu (5-10 分钟，需管理员权限)…` });
    const r = await installWsl({ network, onProgress });
    if (!r.ok) {
      const hint = r.needElevation
        ? "需要管理员权限。请关闭 cicy-desktop，右键以管理员身份重新启动后再试。"
        : (r.error || "安装失败");
      throw new Error(`WSL 安装失败: ${hint}`);
    }
    // Invalidate cache and re-check
    _cachedUsableDistro = null;
    status = await checkStatus();
    if (!status.usableDistro) {
      throw new Error("WSL 安装后仍然检测不到可用 Linux 发行版，可能需要重启 Windows");
    }
  }

  // Phase 3: Install cicy-code from staged file
  emit({ phase: "installing-cicy-code", message: `安装 cicy-code v${version} 到 WSL (${status.usableDistro})…` });
  const r = await installFromHostFile({ hostPath: hostStagePath, version });
  emit({ phase: "done", message: `已安装 v${r.version}`, version: r.version });
  return r;
}

// ---- cicy-code lifecycle inside WSL ----

const CICY_BIN_PATH = "$HOME/.local/bin/cicy-code";
const CICY_VERSION_PATH = "$HOME/.local/bin/cicy-code.version";

// Resolve the current usable distro for cicy-code. Cached across calls in
// the same process because it doesn't change without a restart, and a fresh
// `wsl -l -v` shellout has measurable latency on Windows.
async function resolveUsableDistro() {
  if (_cachedUsableDistro) return _cachedUsableDistro;
  const status = await checkStatus();
  if (!status.installed || !status.usableDistro) {
    throw new Error("WSL does not have a usable Linux distro (only docker-desktop or none). Install Ubuntu via the homepage Install button.");
  }
  _cachedUsableDistro = status.usableDistro;
  return _cachedUsableDistro;
}

// Run a bash script inside the *usable* distro (skipping docker-desktop etc.)
async function userBash(script, opts = {}) {
  const distro = await resolveUsableDistro();
  return wslBash(script, { ...opts, distro });
}

// Read installed version (if any). Empty string when missing.
async function userVersion() {
  try {
    const r = await userBash(`cat ${CICY_VERSION_PATH} 2>/dev/null || true`);
    return r.ok ? r.stdout : "";
  } catch { return ""; }
}

async function userInstalled() {
  try {
    const r = await userBash(`test -x ${CICY_BIN_PATH} && echo ok || echo no`);
    return r.ok && r.stdout === "ok";
  } catch { return false; }
}

// Install cicy-code into WSL by copying a pre-downloaded binary from the
// Windows host into the distro. Uses wslpath to translate C:\... → /mnt/c/...
// then cp + chmod + verify --version.
//
// This is invoked by installer.js after it has finished a parallel-race
// download to userData on the Windows side. The wsl module never touches
// the network — we share download logic with macOS/Linux.
//
// Returns { ok, version } where version is the value reported by the binary
// (which may differ from `expectedVersion` if a mirror served stale content).
async function installFromHostFile({ hostPath, version }) {
  if (!hostPath || !version) throw new Error("installFromHostFile: hostPath + version required");

  const distro = await resolveUsableDistro();

  // Translate Windows path to /mnt/c/... so WSL can read it. Use the same
  // distro that will run the install script (paths are per-distro mounts).
  const trans = await wslRun(["-d", distro, "-e", "wslpath", "-a", hostPath], { timeoutMs: 5000 });
  if (!trans.ok) throw new Error(`wslpath failed: ${trans.stderr || trans.error}`);
  const wslHostPath = trans.stdout.replace(/\u0000/g, "").trim();
  if (!wslHostPath.startsWith("/")) throw new Error(`wslpath returned unexpected: ${wslHostPath}`);

  const script = `
set -eu
mkdir -p "$HOME/.local/bin"
cp '${wslHostPath.replace(/'/g, `'\\''`)}' "${CICY_BIN_PATH}.new"
chmod +x "${CICY_BIN_PATH}.new"
mv -f "${CICY_BIN_PATH}.new" "${CICY_BIN_PATH}"
ACTUAL=$("${CICY_BIN_PATH}" --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
if [ -z "$ACTUAL" ]; then ACTUAL='${version}'; fi
printf '%s' "$ACTUAL" > "${CICY_VERSION_PATH}"
echo "INSTALLED_VERSION=$ACTUAL"
`.trim();

  const r = await wslBash(script, { distro, timeoutMs: 60_000 });
  if (!r.ok) {
    log.warn(`[wsl] installFromHostFile failed (distro=${distro}): ${r.stderr || r.stdout}`);
    throw new Error(r.stderr || "wsl install failed");
  }

  const m = r.stdout.match(/INSTALLED_VERSION=([0-9.]+)/);
  const actual = m ? m[1] : version;
  log.info(`[wsl] installed cicy-code v${actual} into ${distro} (expected v${version})`);
  return { ok: true, version: actual };
}

// Start cicy-code as a background process inside WSL. With `force: true` we
// skip the "already running" check — that path is for the restart IPC where
// the caller has already killed any running instance.
async function start({ port = 8008, force = false } = {}) {
  const distro = await resolveUsableDistro();
  const guard = force ? "" : "if pgrep -f cicy-code >/dev/null 2>&1; then echo \"already running\"; exit 0; fi";
  const script = `
set -eu
LOG="$HOME/.cicy-code.log"
if [ ! -x "${CICY_BIN_PATH}" ]; then echo "binary missing" >&2; exit 1; fi
${guard}
nohup ${CICY_BIN_PATH} > "$LOG" 2>&1 &
disown
sleep 1
pgrep -f cicy-code | head -1
`.trim();
  const r = await wslBash(script, { distro, timeoutMs: 8000 });
  if (!r.ok) throw new Error(r.stderr || "wsl start failed");
  const pid = parseInt(r.stdout.split(/\r?\n/).filter(Boolean).pop(), 10) || null;
  log.info(`[wsl] cicy-code started pid=${pid} in ${distro}`);
  return { pid };
}

// Stop cicy-code in WSL. pkill -9 is the simplest correct primitive — same as
// the unified restart path on macOS/Linux.
async function stop() {
  try {
    await userBash("pkill -9 -f cicy-code 2>/dev/null || true", { timeoutMs: 5000 });
  } catch {}
}

// ---- exports ----

module.exports = {
  checkStatus,
  installWsl,
  setupAll,
  userInstalled,
  userVersion,
  installFromHostFile,
  start,
  stop,
};
