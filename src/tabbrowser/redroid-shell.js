// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// A persistent bash session (inside the WSL distro on Windows, local bash
// elsewhere) that runs commands serially over one process.
//
// Why not execFile per call: the Redroid panel fires a screenshot every few
// hundred ms plus status polls and input events. Each `wsl.exe -d …` launch is
// a fresh WSL session (LxssManager round-trip, ~150-400 ms) and under that
// churn sessions stall and fail with an empty "Command failed" — observed on
// the Win11 21H2 built-in WSL. One long-lived shell removes the per-call
// session cost entirely and makes the screen stream smooth.
//
// Protocol: every command is wrapped as
//   ( <cmd> ) </dev/null 2>&1 ; printf '\n<SENTINEL> %s\n' $?
// (a subshell, so an `exit N` inside the command can't take the session down)
// and we read stdout until the sentinel line. A command that exceeds its
// timeout kills the whole session (the only safe way to abort a stuck child);
// queued commands are rejected and the next call respawns.
const { spawn } = require("child_process");

const SENTINEL = "__CICY_RD_DONE__";

class ShellSession {
  constructor({ spawnArgs, label = "shell" }) {
    this.spawnArgs = spawnArgs; // () => [cmd, args]
    this.label = label;
    this.proc = null;
    this.queue = [];
    this.current = null;
    this.buf = "";
    this.seq = 0;
  }

  _spawn() {
    const [cmd, args] = this.spawnArgs();
    const p = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    p.stdout.on("data", (d) => this._onData(d));
    p.stderr.on("data", () => {}); // merged into stdout by the wrapper; keep the pipe drained
    p.on("exit", () => { if (this.proc === p) { this.proc = null; this._failAll(new Error(`${this.label} session exited`)); } });
    p.on("error", (e) => { if (this.proc === p) { this.proc = null; this._failAll(e); } });
    this.proc = p;
    this.buf = "";
  }

  _failAll(err) {
    const cur = this.current; this.current = null;
    if (cur) { clearTimeout(cur.timer); cur.reject(err); }
    const q = this.queue; this.queue = [];
    for (const j of q) j.reject(err);
  }

  _onData(chunk) {
    this.buf += chunk.toString("utf8");
    const cur = this.current;
    if (!cur) return;
    const idx = this.buf.indexOf(cur.mark);
    if (idx < 0) return;
    const after = this.buf.slice(idx + cur.mark.length);
    const nl = after.indexOf("\n");
    if (nl < 0) return; // exit code not fully arrived yet
    const code = Number(after.slice(0, nl).trim());
    let out = this.buf.slice(0, idx);
    if (out.endsWith("\n")) out = out.slice(0, -1);
    this.buf = after.slice(nl + 1);
    this.current = null;
    clearTimeout(cur.timer);
    if (code === 0) cur.resolve({ stdout: out, stderr: "" });
    else { const e = new Error(`exit ${code}`); e.code = code; e.stdout = out; e.stderr = ""; cur.reject(e); }
    this._next();
  }

  _next() {
    if (this.current || !this.queue.length) return;
    if (!this.proc) { try { this._spawn(); } catch (e) { this._failAll(e); return; } }
    const job = this.queue.shift();
    this.current = job;
    job.timer = setTimeout(() => {
      const e = new Error(`timeout after ${job.timeout}ms: ${job.cmd.slice(0, 80)}`);
      e.killed = true;
      const p = this.proc; this.proc = null;
      try { p && p.kill("SIGKILL"); } catch {}
      this._failAll(e);
    }, job.timeout);
    const line = `( ${job.cmd}\n) </dev/null 2>&1 ; printf '\\n%s %s\\n' ${job.mark} $?\n`;
    try { this.proc.stdin.write(line); } catch (e) { this._failAll(e); }
  }

  run(cmd, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const mark = `${SENTINEL}${++this.seq}`;
      this.queue.push({ cmd, timeout, mark, resolve, reject, timer: null });
      this._next();
    });
  }

  dispose() { const p = this.proc; this.proc = null; try { p && p.kill(); } catch {} this._failAll(new Error("disposed")); }
}

function spawnArgsFor() {
  if (process.platform === "win32") {
    const docker = require("../sidecar/docker");
    const distro = process.env.CICY_WSL_DISTRO || "cicy-code-wsl";
    return () => [docker.wslExe(), ["-d", distro, "-u", "root", "--", "bash", "--norc", "--noprofile"]];
  }
  return () => ["bash", ["--norc", "--noprofile"]];
}

const lanes = new Map();
// lane "ui": screenshots + input (latency-sensitive); lane "mgmt": docker/adb
// status + actions. A slow docker call never blocks the screen stream.
function lane(name) {
  if (!lanes.has(name)) lanes.set(name, new ShellSession({ spawnArgs: spawnArgsFor(), label: `redroid-${name}` }));
  return lanes.get(name);
}

module.exports = { ShellSession, lane, SENTINEL };
