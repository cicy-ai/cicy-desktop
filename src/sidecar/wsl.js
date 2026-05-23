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

const { execFile, spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const log = require("electron-log");

// ── tunables ─────────────────────────────────────────────────────────
const PORT_DEFAULT = 8008;

const DOCKER_INTERNAL_DISTROS = new Set([
  "docker-desktop",
  "docker-desktop-data",
  "docker-desktop-bootstrap",
]);

const PREFERRED_DISTROS = [
  "Ubuntu", "Ubuntu-24.04", "Ubuntu-22.04", "Ubuntu-20.04", "Debian",
];

// Apt mirror candidates by network. Inserted as deb-style entries; deb822
// (Noble+) ubuntu.sources is moved aside if present so the deb-style file
// takes effect.
const APT_MIRRORS = {
  cn:     ["https://mirrors.aliyun.com/ubuntu", "https://mirrors.tuna.tsinghua.edu.cn/ubuntu", "http://archive.ubuntu.com/ubuntu"],
  global: ["http://archive.ubuntu.com/ubuntu", "https://mirrors.aliyun.com/ubuntu"],
};

// Cached usable distro — resolved on first call to resolveUsableDistro().
// Reset to null to invalidate (e.g. after running `wsl --install`).
let _cachedUsableDistro = null;

// ── primitives ────────────────────────────────────────────────────────

function wslRun(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile("wsl", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: clean(stdout),
        stderr: clean(stderr),
        code: err ? (err.code ?? 1) : 0,
        error: err ? err.message : null,
      });
    });
  });
}

// Run a bash script inside a specific distro. Pass via stdin (via base64) to
// avoid Windows quoting hell. Always uses `bash -l` so PATH is loaded.
function wslBash(script, { distro, timeoutMs = 60_000 } = {}) {
  if (!distro) return Promise.reject(new Error("wslBash requires distro"));
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return wslRun(["-d", distro, "--", "bash", "-c", `echo ${b64} | base64 -d | bash -l`], { timeoutMs });
}

function clean(buf) {
  return String(buf || "").replace(/\u0000/g, "").replace(/\r/g, "").trim();
}

// ── status / detection ────────────────────────────────────────────────

function pickUsableDistro(distros) {
  for (const want of PREFERRED_DISTROS) {
    const found = distros.find(d => d.name.toLowerCase() === want.toLowerCase());
    if (found) return found.name;
  }
  const general = distros.find(d => !DOCKER_INTERNAL_DISTROS.has(d.name.toLowerCase()));
  return general ? general.name : null;
}

async function checkStatus() {
  const status = await wslRun(["--status"], { timeoutMs: 5_000 });
  if (!status.ok) return { installed: false };

  const list = await wslRun(["-l", "-v"], { timeoutMs: 5_000 });
  if (!list.ok || !list.stdout) return { installed: true, hasDistro: false };

  const distros = [];
  let defaultDistro = null;
  for (const raw of list.stdout.split(/\n/)) {
    const isDefault = raw.trimStart().startsWith("*");
    const stripped = raw.replace(/^\s*\*?\s*/, "").trim();
    if (!stripped || /^NAME\b/i.test(stripped)) continue;
    const parts = stripped.split(/\s+/);
    if (parts.length < 3) continue;
    const [name, state, version] = parts;
    distros.push({ name, state, version });
    if (isDefault) defaultDistro = name;
  }
  if (!distros.length) return { installed: true, hasDistro: false };

  const usableDistro = pickUsableDistro(distros);
  return {
    installed: true,
    hasDistro: usableDistro !== null,
    distros,
    defaultDistro,
    distro: usableDistro || defaultDistro,
    usableDistro,
    version: distros.find(d => d.name === (usableDistro || defaultDistro))?.version === "2" ? "WSL2" : "WSL1",
  };
}

async function resolveUsableDistro() {
  if (_cachedUsableDistro) return _cachedUsableDistro;
  const status = await checkStatus();
  if (!status.installed || !status.usableDistro) {
    throw new Error("WSL has no usable Linux distro (only docker-desktop or none). Install Ubuntu via the homepage Install button.");
  }
  _cachedUsableDistro = status.usableDistro;
  return _cachedUsableDistro;
}

// ── .wslconfig (vmIdleTimeout) ────────────────────────────────────────
// WSL2 by default shuts down idle distros after 60s, killing background
// processes (including our cicy-code daemon). Set vmIdleTimeout=-1 in
// %USERPROFILE%/.wslconfig so the distro stays alive as long as Windows
// itself is up.
function ensureWslConfig() {
  try {
    const cfgPath = path.join(os.homedir(), ".wslconfig");
    let existing = "";
    try { existing = fs.readFileSync(cfgPath, "utf8"); } catch {}
    if (/vmIdleTimeout\s*=\s*-1/i.test(existing)) return false;
    let next;
    if (/^\[wsl2\]/im.test(existing)) {
      // Replace any existing vmIdleTimeout under [wsl2], else append.
      if (/vmIdleTimeout\s*=/i.test(existing)) {
        next = existing.replace(/vmIdleTimeout\s*=\s*[^\r\n]*/i, "vmIdleTimeout=-1");
      } else {
        next = existing.replace(/^(\[wsl2\][^\[]*)/im, (m) => m.replace(/\s*$/, "") + "\nvmIdleTimeout=-1\n");
      }
    } else {
      next = (existing.trim() ? existing.trim() + "\n\n" : "") + "[wsl2]\nvmIdleTimeout=-1\n";
    }
    fs.writeFileSync(cfgPath, next, "utf8");
    log.info("[wsl] wrote .wslconfig with vmIdleTimeout=-1");
    return true;
  } catch (e) {
    log.warn(`[wsl] ensureWslConfig: ${e.message}`);
    return false;
  }
}

// ── install WSL ───────────────────────────────────────────────────────
function wslSpawn(args, { onLine, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("wsl", args, { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    const handle = (buf, isErr) => {
      const s = clean(buf);
      if (isErr) stderr += s; else stdout += s;
      for (const line of s.split(/\n/)) {
        if (line.trim() && onLine) try { onLine(line.trim()); } catch {}
      }
    };
    child.stdout.on("data", b => handle(b, false));
    child.stderr.on("data", b => handle(b, true));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, stdout, stderr }); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout, stderr }); });
  });
}

async function installWsl({ network = "unknown", onProgress } = {}) {
  const emit = (e) => { try { onProgress && onProgress(e); } catch {} };
  const onLine = (line) => emit({ phase: "wsl-installing", message: line });

  // CN-first: web-download avoids Microsoft Store, GitHub-hosted distro
  // tarballs work via direct connection in most networks.
  const preferWebDownload = network === "cn" || network === "unknown";

  if (preferWebDownload) {
    log.info("[wsl] trying: wsl --install --web-download --no-launch -d Ubuntu");
    emit({ phase: "wsl-installing", message: "Installing WSL2 + Ubuntu (via web download)…" });
    const r = await wslSpawn(["--install", "--web-download", "--no-launch", "-d", "Ubuntu"], { onLine });
    if (r.ok) return { ok: true, method: "web-download" };
    log.warn(`[wsl] web-download failed (code=${r.code}): ${r.stderr.slice(0, 200)}`);
  }

  log.info("[wsl] trying: wsl --install --no-launch -d Ubuntu");
  emit({ phase: "wsl-installing", message: "Installing WSL2 + Ubuntu (via Microsoft Store)…" });
  const r = await wslSpawn(["--install", "--no-launch", "-d", "Ubuntu"], { onLine });
  if (r.ok) return { ok: true, method: "store" };

  log.warn(`[wsl] install failed (code=${r.code}): ${r.stderr.slice(0, 200)}`);

  // Last resort: download Ubuntu rootfs directly from cloud-images mirrors
  // and `wsl --import`. Bypasses raw.githubusercontent.com (which Microsoft
  // hits to fetch DistributionInfo.json) and Microsoft Store. This works
  // even when both `wsl --install` paths fail (common in restricted networks
  // like Myanmar/CN where raw.githubusercontent.com is unreliable).
  const githubBlocked = /raw\.githubusercontent|0x800|connect|��|��Ӧ/.test(r.stderr || "");
  if (githubBlocked) {
    log.info("[wsl] falling back to direct rootfs import");
    emit({ phase: "wsl-installing", message: "Direct GitHub blocked — falling back to rootfs import…" });
    try {
      const ir = await importUbuntuFromRootfs({ network, onProgress });
      if (ir.ok) return { ok: true, method: "rootfs-import" };
    } catch (e) {
      log.warn(`[wsl] rootfs-import failed: ${e.message}`);
    }
  }

  return {
    ok: false,
    code: r.code,
    error: r.stderr || `wsl --install exit ${r.code}`,
    needElevation: r.code === 740 || /elevat|administrat|denied/i.test(r.stderr || ""),
  };
}

// Fallback when `wsl --install -d Ubuntu` cannot fetch its distro manifest
// (raw.githubusercontent.com unreachable). We download an Ubuntu rootfs
// directly from a reachable cloud-images mirror and `wsl --import` it.
async function importUbuntuFromRootfs({ network = "unknown", onProgress } = {}) {
  const emit = (e) => { try { onProgress && onProgress(e); } catch {} };
  const baseMirrors = network === "cn"
    ? [
        "https://mirror.nju.edu.cn/ubuntu-cloud-images/wsl/jammy/current",
        "https://mirrors.ustc.edu.cn/ubuntu-cloud-images/wsl/jammy/current",
        "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/jammy/current",
        "https://cloud-images.ubuntu.com/wsl/jammy/current",
      ]
    : [
        "https://cloud-images.ubuntu.com/wsl/jammy/current",
        "https://mirror.nju.edu.cn/ubuntu-cloud-images/wsl/jammy/current",
        "https://mirrors.ustc.edu.cn/ubuntu-cloud-images/wsl/jammy/current",
      ];
  const fileName = "ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz";

  // Pick fastest reachable mirror via HEAD probe.
  emit({ phase: "wsl-installing", message: "Picking fastest Ubuntu rootfs mirror…" });
  const winTmp = process.env.TEMP || path.join(os.tmpdir());
  const tarPath = path.join(winTmp, "ubuntu-jammy-wsl.tar.gz");
  const dstDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "WSL", "Ubuntu");
  fs.mkdirSync(dstDir, { recursive: true });

  let chosen = null;
  for (const m of baseMirrors) {
    const url = `${m}/${fileName}`;
    const r = await new Promise((res) => {
      execFile("powershell", [
        "-NoProfile", "-Command",
        `try { $sw = [Diagnostics.Stopwatch]::StartNew(); Invoke-WebRequest '${url}' -Method Head -UseBasicParsing -TimeoutSec 5 | Out-Null; $sw.Stop(); Write-Output $sw.ElapsedMilliseconds } catch { Write-Output -1 }`,
      ], { timeout: 8_000 }, (_e, stdout) => res(parseInt(String(stdout).trim(), 10)));
    });
    if (r >= 0) { chosen = url; log.info(`[wsl] rootfs mirror chosen: ${url} (${r}ms HEAD)`); break; }
  }
  if (!chosen) return { ok: false, error: "no reachable rootfs mirror" };

  emit({ phase: "wsl-installing", message: `Downloading Ubuntu rootfs (~350MB)…` });
  const dl = await new Promise((res) => {
    execFile("powershell", [
      "-NoProfile", "-Command",
      `$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest '${chosen}' -OutFile '${tarPath}' -UseBasicParsing -TimeoutSec 1800; Write-Output ((Get-Item '${tarPath}').Length) } catch { Write-Output ('ERR ' + $_.Exception.Message); exit 1 }`,
    ], { timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
      const out = String(stdout || "").trim();
      if (e || out.startsWith("ERR")) return res({ ok: false, error: out || stderr });
      res({ ok: true, size: parseInt(out, 10) || 0 });
    });
  });
  if (!dl.ok) return dl;
  if (dl.size < 50_000_000) return { ok: false, error: `rootfs too small: ${dl.size} bytes` };
  log.info(`[wsl] downloaded ${dl.size} bytes to ${tarPath}`);

  emit({ phase: "wsl-installing", message: "Importing as Ubuntu distro…" });
  const imp = await wslRun(["--import", "Ubuntu", dstDir, tarPath, "--version", "2"], { timeoutMs: 5 * 60_000 });
  if (!imp.ok) return { ok: false, error: imp.stderr || "wsl --import failed" };

  // Cleanup tarball after successful import.
  try { fs.unlinkSync(tarPath); } catch {}
  return { ok: true, method: "rootfs-import" };
}

async function waitForDistroReady(distro, { timeoutMs = 90_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await wslRun(["-d", distro, "-e", "true"], { timeoutMs: 8_000 });
    if (r.ok) return true;
    await new Promise(res => setTimeout(res, 3_000));
  }
  return false;
}

// ── apt mirror handling ──────────────────────────────────────────────
async function ensureAptSourcesReachable({ network = "unknown" } = {}) {
  const distro = await resolveUsableDistro();

  // Probe current mirror (handles deb-style and deb822).
  const probe = await wslBash(`set +e
. /etc/os-release
echo "CODENAME=$VERSION_CODENAME"
CUR=$(grep -m1 -hoE 'https?://[^ /]+' /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null | head -1)
echo "CUR=$CUR"
if [ -n "$CUR" ] && curl -fsI --max-time 5 "$CUR" >/dev/null 2>&1; then
  echo "REACHABLE=1"
else
  echo "REACHABLE=0"
fi`, { distro, timeoutMs: 25_000 });
  if (!probe.ok) return { ok: false, error: "probe failed: " + probe.stderr };

  const env = Object.fromEntries(probe.stdout.split("\n").map(l => {
    const i = l.indexOf("="); return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)];
  }));
  if (env.REACHABLE === "1") {
    log.info(`[wsl] apt mirror reachable: ${env.CUR}`);
    return { ok: true, mirror: env.CUR, changed: false };
  }
  log.info(`[wsl] current apt mirror unreachable (${env.CUR || "n/a"}), probing alternatives`);

  const candidates = APT_MIRRORS[network] || APT_MIRRORS.global;
  const codename = env.CODENAME || "jammy";
  const probeScript = candidates
    .map(c => `if curl -fsI --max-time 5 "${c}/dists/${codename}/Release" >/dev/null 2>&1; then echo "${c}"; exit 0; fi`)
    .join("\n");
  const pick = await wslBash(probeScript + "\nexit 1", { distro, timeoutMs: 30_000 });
  if (!pick.ok || !pick.stdout) return { ok: false, error: "no reachable apt mirror" };
  const mirror = pick.stdout.split(/\n/).filter(Boolean).pop();

  const newList = [
    `deb ${mirror} ${codename} main restricted universe multiverse`,
    `deb ${mirror} ${codename}-updates main restricted universe multiverse`,
    `deb ${mirror} ${codename}-backports main restricted universe multiverse`,
    `deb ${mirror} ${codename}-security main restricted universe multiverse`,
  ].join("\n");

  const w = await wslBash(`set -e
CONTENT='${newList.replace(/'/g, `'\\''`)}'
write_file() {
  local f="$1"
  if [ -w "$f" ] || [ ! -e "$f" ]; then printf '%s\\n' "$CONTENT" > "$f";
  elif command -v sudo >/dev/null 2>&1; then printf '%s\\n' "$CONTENT" | sudo tee "$f" >/dev/null;
  else return 1; fi
}
if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
  # Disable deb822 so deb-style /etc/apt/sources.list takes effect.
  if [ -w /etc/apt/sources.list.d/ubuntu.sources ]; then
    mv /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.bak
  elif command -v sudo >/dev/null 2>&1; then
    sudo mv /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.bak
  fi
fi
write_file /etc/apt/sources.list || { echo "no-write-access" >&2; exit 1; }
echo MIRROR=${mirror}`, { distro, timeoutMs: 10_000 });
  if (!w.ok) return { ok: false, error: w.stderr || "write failed" };
  log.info(`[wsl] rewrote sources.list → ${mirror}`);
  return { ok: true, mirror, changed: true };
}

// ── cicy-code lifecycle inside wsl ───────────────────────────────────
const CICY_BIN = "$HOME/.local/bin/cicy-code";
const CICY_VER = "$HOME/.local/bin/cicy-code.version";

async function userBash(script, opts = {}) {
  const distro = await resolveUsableDistro();
  return wslBash(script, { ...opts, distro });
}

async function userInstalled() {
  try {
    const r = await userBash(`test -x ${CICY_BIN} && echo ok || echo no`, { timeoutMs: 5_000 });
    return r.ok && r.stdout === "ok";
  } catch { return false; }
}

async function userVersion() {
  try {
    const r = await userBash(`cat ${CICY_VER} 2>/dev/null || true`, { timeoutMs: 5_000 });
    return r.ok ? r.stdout.trim() : "";
  } catch { return ""; }
}

// Ensure /etc/wsl.conf inside the distro has a [boot] command that
// auto-launches cicy-code whenever the distro is started. Combined with
// %USERPROFILE%/.wslconfig (vmIdleTimeout=-1) this means:
//   - Windows reboot → user signs in → cicy-desktop auto-launches (--hidden)
//     → wsl.start() probes WSL → triggers distro boot → boot.command starts
//     cicy-code under the default user → :8008 is up.
//   - cicy-desktop killed/crashed: distro stays alive (vmIdleTimeout=-1) and
//     cicy-code with it.
//   - User runs `wsl --shutdown`: next time anything touches WSL, distro
//     boots and boot.command starts cicy-code automatically.
async function ensureDistroBootCommand(distro) {
  if (!distro) return false;
  // Probe default user — boot.command runs as root, we need to su to the
  // distro's default user (the one cicy-code was installed under).
  const u = await wslBash(`grep -m1 '^default=' /etc/wsl.conf 2>/dev/null | cut -d= -f2 | tr -d ' \\t' || echo ""`, { distro, timeoutMs: 5_000 });
  let user = (u.ok ? u.stdout : "").trim();
  if (!user) {
    // Fallback: user with uid 1000.
    const fb = await wslBash(`getent passwd 1000 | cut -d: -f1`, { distro, timeoutMs: 5_000 });
    user = (fb.ok ? fb.stdout : "").trim();
  }
  if (!user) {
    log.warn(`[wsl] no default user found in ${distro}; skipping boot.command setup`);
    return false;
  }

  const bootCmd = `su - ${user} -c 'pgrep -f cicy-code >/dev/null 2>&1 || setsid -f $HOME/.local/bin/cicy-code </dev/null >>$HOME/.cicy-code.log 2>&1'`;
  // Idempotent rewrite: if [boot] command already matches, skip.
  const r = await wslBash(`set -e
TARGET='${bootCmd.replace(/'/g, `'\\''`)}'
if [ -f /etc/wsl.conf ] && grep -qF "$TARGET" /etc/wsl.conf 2>/dev/null; then
  echo unchanged
  exit 0
fi
write() {
  if [ -w /etc/wsl.conf ] || [ ! -e /etc/wsl.conf ]; then "$@" /etc/wsl.conf; return $?; fi
  if command -v sudo >/dev/null 2>&1; then sudo "$@" /etc/wsl.conf; return $?; fi
  return 1
}
TMP=$(mktemp)
if [ -f /etc/wsl.conf ]; then cp /etc/wsl.conf "$TMP"; fi
# Replace any existing [boot] section, else append.
python3 - "$TMP" "$TARGET" <<'PYEOF'
import re, sys
path, cmd = sys.argv[1], sys.argv[2]
try:
    with open(path) as f: content = f.read()
except FileNotFoundError:
    content = ""
new_section = "[boot]\\nsystemd=false\\ncommand=" + cmd + "\\n"
if re.search(r'^\\[boot\\]', content, re.M):
    content = re.sub(r'^\\[boot\\][^\\[]*', new_section, content, flags=re.M)
else:
    if content and not content.endswith("\\n"): content += "\\n"
    content += "\\n" + new_section
with open(path, "w") as f: f.write(content)
PYEOF
if [ -w /etc/wsl.conf ] || [ ! -e /etc/wsl.conf ]; then
  cp "$TMP" /etc/wsl.conf
elif command -v sudo >/dev/null 2>&1; then
  sudo cp "$TMP" /etc/wsl.conf
fi
rm -f "$TMP"
echo updated`, { distro, timeoutMs: 15_000 });
  if (!r.ok) { log.warn(`[wsl] ensureDistroBootCommand failed: ${r.stderr}`); return false; }
  log.info(`[wsl] /etc/wsl.conf [boot] command: ${r.stdout.trim()} (user=${user})`);
  return true;
}

async function installFromHostFile({ hostPath, version }) {
  if (!hostPath || !version) throw new Error("installFromHostFile requires hostPath + version");
  const distro = await resolveUsableDistro();

  const trans = await wslRun(["-d", distro, "-e", "wslpath", "-a", hostPath], { timeoutMs: 5_000 });
  if (!trans.ok) throw new Error(`wslpath failed: ${trans.stderr || trans.error}`);
  const wslHostPath = trans.stdout;
  if (!wslHostPath.startsWith("/")) throw new Error(`wslpath returned: ${wslHostPath}`);

  const r = await wslBash(`set -eu
mkdir -p "$HOME/.local/bin"
cp '${wslHostPath.replace(/'/g, `'\\''`)}' "${CICY_BIN}.new"
chmod +x "${CICY_BIN}.new"
mv -f "${CICY_BIN}.new" "${CICY_BIN}"
ACT=$("${CICY_BIN}" --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
[ -n "$ACT" ] || ACT='${version}'
printf '%s' "$ACT" > "${CICY_VER}"
echo "INSTALLED:$ACT"`, { distro, timeoutMs: 60_000 });
  if (!r.ok) throw new Error(r.stderr || "install failed");
  const m = r.stdout.match(/INSTALLED:([0-9.]+)/);
  const actual = m ? m[1] : version;
  log.info(`[wsl] installed cicy-code v${actual} into ${distro}`);
  // After install, also wire up boot.command so cicy-code auto-starts on
  // future distro boots (Windows reboot, wsl --shutdown, etc.)
  await ensureDistroBootCommand(distro);
  return { ok: true, version: actual };
}

// Start cicy-code as a detached background process inside WSL. Tested
// pattern: `nohup ... </dev/null >>LOG 2>&1 & disown`. setsid was found to
// make the process exit silently in some Ubuntu rootfs builds, so we use
// plain nohup + disown which works across distros.
async function start({ port = PORT_DEFAULT, force = false } = {}) {
  ensureWslConfig();
  const distro = await resolveUsableDistro();
  // Make sure boot.command is in place — best-effort.
  ensureDistroBootCommand(distro).catch(() => {});

  const guard = force
    ? "pkill -9 -f cicy-code 2>/dev/null || true; sleep 1"
    : `if pgrep -f cicy-code >/dev/null 2>&1; then echo "already running"; exit 0; fi`;
  const r = await wslBash(`set -eu
LOG="$HOME/.cicy-code.log"
[ -x "${CICY_BIN}" ] || { echo "binary missing" >&2; exit 1; }
${guard}
cd "$HOME"
setsid -f "${CICY_BIN}" </dev/null >>"$LOG" 2>&1
sleep 1
pgrep -f cicy-code | head -1`, { distro, timeoutMs: 10_000 });
  if (!r.ok) throw new Error(r.stderr || "wsl start failed");
  const pid = parseInt((r.stdout.split("\n").filter(Boolean).pop() || ""), 10) || null;
  log.info(`[wsl] cicy-code started pid=${pid} in ${distro}`);
  return { pid };
}

async function stop() {
  try {
    await userBash("pkill -9 -f cicy-code 2>/dev/null || true", { timeoutMs: 5_000 });
  } catch {}
}

// Remove a distro entirely. Used by the "reset" path / for QA.
async function unregisterDistro(distro) {
  if (!distro) throw new Error("unregisterDistro requires distro");
  const r = await wslRun(["--unregister", distro], { timeoutMs: 60_000 });
  _cachedUsableDistro = null;
  return { ok: r.ok, error: r.stderr };
}

// ── one-shot flow ────────────────────────────────────────────────────
async function setupAll({ network, hostStagePath, version, onProgress }) {
  const emit = (e) => { try { onProgress && onProgress(e); } catch {} };

  ensureWslConfig();

  emit({ phase: "checking-wsl", message: "Checking WSL state…" });
  let status = await checkStatus();

  if (!status.installed || !status.usableDistro) {
    const reason = !status.installed ? "WSL2 not installed" : "WSL installed but no Linux distro (only docker-desktop)";
    emit({ phase: "installing-wsl", message: `${reason} — installing Ubuntu (5–10 min, requires admin)…` });
    const r = await installWsl({ network, onProgress });
    if (!r.ok) {
      const hint = r.needElevation
        ? "Administrator privileges required. Quit cicy-desktop and relaunch as admin."
        : (r.error || "install failed");
      throw new Error("WSL install failed: " + hint);
    }
    _cachedUsableDistro = null;
    status = await checkStatus();
    if (!status.usableDistro) throw new Error("WSL installed but no usable distro detected — Windows may need a reboot");
    emit({ phase: "waiting-distro", message: `Waiting for ${status.usableDistro} to boot…` });
    if (!await waitForDistroReady(status.usableDistro)) {
      throw new Error(`${status.usableDistro} did not boot within 90s`);
    }
  }

  emit({ phase: "configuring-apt", message: "Configuring apt mirror…" });
  try {
    const apt = await ensureAptSourcesReachable({ network });
    if (apt.ok) log.info(`[wsl] apt mirror: ${apt.mirror}${apt.changed ? " (rewritten)" : ""}`);
    else log.warn(`[wsl] apt mirror probe failed: ${apt.error}`);
  } catch (e) {
    log.warn(`[wsl] ensureAptSourcesReachable threw: ${e.message}`);
  }

  emit({ phase: "installing-cicy-code", message: `Installing cicy-code v${version} into WSL (${status.usableDistro})…` });
  const r = await installFromHostFile({ hostPath: hostStagePath, version });
  emit({ phase: "done", message: `Installed v${r.version}`, version: r.version });
  return r;
}

module.exports = {
  checkStatus,
  installWsl,
  setupAll,
  userInstalled,
  userVersion,
  installFromHostFile,
  start,
  stop,
  unregisterDistro,
  ensureWslConfig,
  ensureDistroBootCommand,
};
