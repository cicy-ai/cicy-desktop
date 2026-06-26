// RPC audit log — an append-only record of (a) every electronRPC tool call and
// (b) every authorization decision (including the TEMPORARY ones — "本次允许" /
// "允许一次" / "本页面内允许" — which otherwise live only in memory and leave no
// trace), plus trusted-origin allowlist add/remove. Written as JSONL to
// ~/logs/rpc-audit.log (mode 0600), rotated at 5 MB. (db/ holds data + config
// only — logs live under ~/logs, same as the cicy-code sidecar/keepalive logs.)
//
// Security intent: the RPC bridge can run host code / read-write files, so who
// authorized what, when, and which calls actually ran must be reviewable after
// the fact — not just gated by an in-the-moment modal.
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOG = path.join(os.homedir(), "logs", "rpc-audit.log");
const MAX_BYTES = 5 * 1024 * 1024; // rotate to .1 past this

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG);
    if (st.size > MAX_BYTES) {
      try { fs.renameSync(LOG, LOG + ".1"); } catch {}
    }
  } catch {} // missing file → nothing to rotate
}

// Append one record as a JSON line. NEVER throws — auditing must not break RPC.
function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    rotateIfNeeded();
    const rec = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(LOG, JSON.stringify(rec) + "\n", { mode: 0o600 });
    try { fs.chmodSync(LOG, 0o600); } catch {}
  } catch {}
}

// Short, secret-light preview of args for exec_*/file_* (same fields the consent
// dialog surfaces). Other tools log no args.
function argsPreview(tool, args) {
  try {
    if (/^exec_/.test(tool)) {
      const c = args && (args.command || args.code || args.script || args.cmd);
      if (c) return String(c).slice(0, 240);
    }
    if (/^file_/.test(tool)) {
      const p = args && (args.path || args.filename || args.file);
      if (p) return String(p).slice(0, 240);
    }
  } catch {}
  return "";
}

module.exports = { LOG, audit, argsPreview };
