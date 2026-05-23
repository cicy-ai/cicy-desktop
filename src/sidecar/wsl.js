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

// Run a bash script inside the WSL default distro. Wraps in `bash -lc` so
// .bashrc/.profile is loaded (PATH, etc.).
function wslBash(script, opts) {
  return wslRun(["bash", "-lc", script], opts);
}

// ---- status ----

// Detect WSL availability. Returns:
//   { installed: false }                         — wsl.exe not present
//   { installed: true, hasDistro: false }        — wsl installed but no distro
//   { installed: true, hasDistro: true, distro: "Ubuntu", version: "WSL2" }
async function checkStatus() {
  // Quick existence test — `wsl --status` exits 0 only if wsl is functional.
  const status = await wslRun(["--status"], { timeoutMs: 5000 });
  if (!status.ok) return { installed: false };

  // List distros. Header line is "NAME STATE VERSION", subsequent lines are
  // distro entries. `* Ubuntu  Running  2`. Empty list means no distro.
  // -v: verbose; --quiet: skip header/banner since wsl 2.0+.
  const list = await wslRun(["-l", "-v"], { timeoutMs: 5000 });
  if (!list.ok || !list.stdout) return { installed: true, hasDistro: false };

  // Parse the line marked with `*` (default). Strip null bytes — wsl emits
  // UTF-16-encoded output that often appears as 0x00-padded strings.
  const cleanLines = list.stdout.replace(/\u0000/g, "").split(/\r?\n/).filter(Boolean);
  const def = cleanLines.find(l => l.trimStart().startsWith("*"));
  if (!def) return { installed: true, hasDistro: false };
  const parts = def.replace(/^\s*\*\s*/, "").split(/\s+/);
  return {
    installed: true,
    hasDistro: true,
    distro: parts[0] || "Unknown",
    version: parts[2] === "2" ? "WSL2" : (parts[2] === "1" ? "WSL1" : "Unknown"),
  };
}

// ---- install commands ----

// Trigger `wsl --install -d Ubuntu`. Requires Administrator on Windows 10/11.
// Returns the same shape as wslRun. UI should show the user the command to
// run in an elevated terminal if this fails with permission error.
async function installWsl() {
  log.info("[wsl] running: wsl --install -d Ubuntu");
  return wslRun(["--install", "-d", "Ubuntu"], { timeoutMs: 5 * 60 * 1000 });
}

// ---- cicy-code lifecycle inside WSL ----

const CICY_BIN_PATH = "$HOME/.local/bin/cicy-code";
const CICY_VERSION_PATH = "$HOME/.local/bin/cicy-code.version";

// Read installed version (if any). Empty string when missing.
async function userVersion() {
  const r = await wslBash(`cat ${CICY_VERSION_PATH} 2>/dev/null || true`);
  return r.ok ? r.stdout : "";
}

async function userInstalled() {
  const r = await wslBash(`test -x ${CICY_BIN_PATH} && echo ok || echo no`);
  return r.ok && r.stdout === "ok";
}

// Download + install cicy-code into WSL. assetUrl points to the linux-amd64
// release binary; CN_MIRRORS are tried first when network is "cn".
//
// onProgress receives:
//   { phase: "downloading", message, version, network, received?, total?, progress? }
//   { phase: "installing",  message }
//   { phase: "done",        version }
async function installCicyCode({ version, assetUrl, network, onProgress }) {
  if (!version || !assetUrl) throw new Error("installCicyCode: version + assetUrl required");
  const emit = (e) => { try { onProgress && onProgress(e); } catch {} };

  const { buildUrlList } = require("./mirrors");
  const order = buildUrlList(assetUrl, network);

  // Build a heredoc'd bash script. Use printf to surface progress lines that
  // we parse on the Node side via an exec_shell-style readline pump. (For the
  // first cut we don't stream byte-level progress; curl prints a nice meter
  // to stderr that we surface as-is.)
  const urlsArg = order.map(u => `'${u.replace(/'/g, `'\\''`)}'`).join(" ");
  const script = `
set -eu
mkdir -p "$HOME/.local/bin"
TMP=$(mktemp)
ok=0
for url in ${urlsArg}; do
  echo "[wsl-installer] trying $url"
  if curl -fL --connect-timeout 8 -o "$TMP" "$url"; then ok=1; break; fi
  echo "[wsl-installer] failed: $url"
done
if [ "$ok" -ne 1 ]; then echo "[wsl-installer] all sources failed" >&2; exit 1; fi
chmod +x "$TMP"
mv "$TMP" "${CICY_BIN_PATH}"
printf '%s' '${version}' > "${CICY_VERSION_PATH}"
echo "[wsl-installer] installed v${version}"
`.trim();

  emit({ phase: "downloading", message: "downloading cicy-code", version, network });
  const result = await wslBash(script, { timeoutMs: 5 * 60 * 1000 });
  if (!result.ok) {
    log.warn(`[wsl] install script failed: ${result.stderr || result.stdout}`);
    throw new Error(result.stderr || "wsl install failed");
  }
  emit({ phase: "done", version });
  return { ok: true, version };
}

// Start cicy-code as a background process inside WSL. With `force: true` we
// skip the "already running" check — that path is for the restart IPC where
// the caller has already killed any running instance.
async function start({ port = 8008, force = false } = {}) {
  // Spawn detached, redirect stdout/stderr to a log file in WSL home so we
  // can fetch it later without keeping the wsl process alive.
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
  const r = await wslBash(script, { timeoutMs: 8000 });
  if (!r.ok) throw new Error(r.stderr || "wsl start failed");
  const pid = parseInt(r.stdout.split(/\r?\n/).filter(Boolean).pop(), 10) || null;
  log.info(`[wsl] cicy-code started pid=${pid} (inside distro)`);
  return { pid };
}

// Stop cicy-code in WSL. pkill -9 is the simplest correct primitive — same as
// the unified restart path on macOS/Linux.
async function stop() {
  await wslBash("pkill -9 -f cicy-code 2>/dev/null || true", { timeoutMs: 5000 });
}

// ---- exports ----

module.exports = {
  checkStatus,
  installWsl,
  userInstalled,
  userVersion,
  installCicyCode,
  start,
  stop,
};
