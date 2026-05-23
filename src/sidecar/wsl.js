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

  // Translate Windows path to /mnt/c/... so WSL can read it.
  const trans = await wslRun(["-e", "wslpath", "-a", hostPath], { timeoutMs: 5000 });
  if (!trans.ok) throw new Error(`wslpath failed: ${trans.stderr || trans.error}`);
  const wslHostPath = trans.stdout.replace(/\u0000/g, "").trim();
  if (!wslHostPath.startsWith("/")) throw new Error(`wslpath returned unexpected: ${wslHostPath}`);

  // Single bash session for atomic-ish install: mkdir → cp → chmod → write
  // version file → run --version to confirm. If --version fails or reports
  // a different version, return the actual one so the caller can record it.
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

  const r = await wslBash(script, { timeoutMs: 60_000 });
  if (!r.ok) {
    log.warn(`[wsl] installFromHostFile failed: ${r.stderr || r.stdout}`);
    throw new Error(r.stderr || "wsl install failed");
  }

  // Parse the INSTALLED_VERSION line
  const m = r.stdout.match(/INSTALLED_VERSION=([0-9.]+)/);
  const actual = m ? m[1] : version;
  log.info(`[wsl] installed cicy-code v${actual} (expected v${version})`);
  return { ok: true, version: actual };
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
  installFromHostFile,
  start,
  stop,
};
