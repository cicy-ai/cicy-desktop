// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for the Redroid matrix panel (no Electron / no shell here so
// they are unit-testable): container naming, host adb port allocation, the
// `docker run` command line, `docker ps` parsing and device proxy validation.
//
// Conventions (must match what the panel + watchdog expect):
//   container name   redroid-<slug>            (legacy: bare "redroid"/"redroid11" still listed)
//   label            cicy.redroid=1            (how we find "ours")
//   host adb port    15555+  (NOT 5555-5585: that range is reserved by adb for
//                    emulators and the connection stays "offline" forever)
//   data volume      /root/redroid-<slug>-data:/data  (survives recreate, dropped on purge)

const LABEL = "cicy.redroid";
const PORT_BASE = 15555;
const IMAGES = {
  "11": "redroid/redroid:11.0.0-latest",
  "13": "redroid/redroid:13.0.0-latest",
  "14": "redroid/redroid:14.0.0-latest",
};
const DEFAULT_SPEC = { version: "13", width: 720, height: 1280, dpi: 320 };

function slugify(name) {
  const s = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  if (!s) throw new Error("设备名不能为空（只保留字母、数字和 -）");
  return s;
}
function containerName(name) { return `redroid-${slugify(name)}`; }
function dataDir(container) { return `/root/${container}-data`; }

// Next free host port ≥ PORT_BASE given the ports already published by
// existing redroid containers (any order, holes are reused).
function allocatePort(usedPorts) {
  const used = new Set((usedPorts || []).map(Number).filter(Number.isFinite));
  let p = PORT_BASE;
  while (used.has(p)) p += 1;
  return p;
}

function normalizeSpec(input = {}) {
  const version = String(input.version || DEFAULT_SPEC.version);
  if (!IMAGES[version]) throw new Error(`不支持的 Android 版本 ${version}（可选 ${Object.keys(IMAGES).join("/")}）`);
  const num = (v, d, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) return d; return Math.round(n); };
  return {
    version,
    image: IMAGES[version],
    width: num(input.width, DEFAULT_SPEC.width, 240, 4096),
    height: num(input.height, DEFAULT_SPEC.height, 240, 4096),
    dpi: num(input.dpi, DEFAULT_SPEC.dpi, 120, 640),
  };
}

// The docker command line for a fresh device. `gpu_mode=guest` = software
// rendering: WSL2 has no /dev/dri and the host mode hangs surfaceflinger.
function buildRunCommand({ container, port, spec }) {
  const s = normalizeSpec(spec);
  return [
    "docker run -d",
    `--name ${container}`,
    `--label ${LABEL}=1`,
    `--label ${LABEL}.version=${s.version}`,
    "--privileged",
    "--restart unless-stopped",
    `-v ${dataDir(container)}:/data`,
    `-p ${port}:5555`,
    s.image,
    "androidboot.redroid_gpu_mode=guest",
    `androidboot.redroid_width=${s.width}`,
    `androidboot.redroid_height=${s.height}`,
    `androidboot.redroid_dpi=${s.dpi}`,
  ].join(" ");
}

// Parse `docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'`.
// Keeps only redroid images; extracts the published host port for 5555/tcp.
function parsePs(stdout) {
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, image, state, status, ports = ""] = line.split("\t");
    if (!/^redroid\/redroid:/.test(image || "")) continue;
    const m = /(?:^|[\s,])(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|):?(\d+)->5555\/tcp/.exec(ports) || /:(\d+)->5555\/tcp/.exec(ports);
    const vm = /redroid:(\d+)\./.exec(image);
    out.push({
      name, image, state, status,
      version: vm ? vm[1] : "",
      port: m ? Number(m[1]) : null,
      running: state === "running",
    });
  }
  return out.sort((a, b) => (a.port || 0) - (b.port || 0) || a.name.localeCompare(b.name));
}

// Android `settings put global http_proxy` wants host:port (or ":0" = off).
// Accept "host:port" or "http://host:port"; reject anything else so a typo
// never silently leaves the device on direct egress.
function normalizeDeviceProxy(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  let host = v, port = "";
  const u = /^(?:https?:\/\/)?([^/:\s]+):(\d{1,5})\/?$/.exec(v);
  if (!u) throw new Error("代理格式应为 host:port（例如 172.18.0.2:20011），留空 = 直连");
  host = u[1]; port = u[2];
  if (Number(port) < 1 || Number(port) > 65535) throw new Error("代理端口无效");
  return `${host}:${port}`;
}

const AOSP_KEYS = { home: 3, back: 4, recents: 187, power: 26, volup: 24, voldown: 25, enter: 66, del: 67, menu: 82 };

// adb `input` argument list for one gesture/keypress. Text goes through
// `input text` with the characters adb chokes on escaped; anything non-ASCII
// is sent per key event fallback (adb's input text is ASCII-only).
function inputArgs(ev) {
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  switch (ev && ev.type) {
    case "tap": return ["input", "tap", n(ev.x), n(ev.y)];
    case "swipe": return ["input", "swipe", n(ev.x1), n(ev.y1), n(ev.x2), n(ev.y2), n(ev.ms || 200)];
    case "key": {
      const code = AOSP_KEYS[String(ev.key)] || (Number.isInteger(Number(ev.key)) ? Number(ev.key) : null);
      if (code == null) throw new Error(`unknown key ${ev.key}`);
      return ["input", "keyevent", code];
    }
    case "text": {
      const t = String(ev.text || "");
      if (!t) throw new Error("empty text");
      if (/[^\x20-\x7e]/.test(t)) throw new Error("adb input text 只支持 ASCII");
      // spaces → %s, and shell-escape the rest via single quotes
      return ["input", "text", `'${t.replace(/'/g, "'\\''").replace(/ /g, "%s")}'`];
    }
    default: throw new Error(`unknown input ${ev && ev.type}`);
  }
}

module.exports = {
  LABEL, PORT_BASE, IMAGES, DEFAULT_SPEC, AOSP_KEYS,
  slugify, containerName, dataDir, allocatePort, normalizeSpec, buildRunCommand, parsePs,
  normalizeDeviceProxy, inputArgs,
};
