# Electron Inject Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a restricted Desktop RPC and public `agent-electron` CLI that install JavaScript into `~/data/electron/extension/inject/`.

**Architecture:** Desktop owns path validation and atomic host writes through one `electron_inject` tool. The public Skill reads a caller-provided source file and forwards its UTF-8 content without printing it.

**Tech Stack:** Electron/Node.js CommonJS Desktop tools, Zod schemas, Node test runner, ESM public Skill CLI.

**Spec:** `docs/superpowers/specs/2026-08-23-electron-inject-installer-design.md`

## Global Constraints

- Fixed Desktop root: `path.join(os.homedir(), "data", "electron", "extension", "inject")`.
- Accept only filenames matching `^[a-z0-9][a-z0-9._-]*\.js$`.
- Reject payloads larger than 1 MiB and never return JavaScript content.
- Use atomic sibling-temp write, mode `0600`, and SHA-256 verification.
- Do not use the existing arbitrary-path `file_write` tool.

---

### Task 1: Desktop `electron_inject` RPC

**Files:**
- Create: `src/tools/electron-inject-tools.js`
- Modify: `src/tools/index.js`
- Modify: `src/utils/rpc-guard.js`
- Test: `test/electron-inject-tools.test.js`

**Interfaces:**
- Consumes: `{operation:"install"|"status"|"uninstall", name:string, content?:string}`.
- Produces: `{operation,name,path,exists,size,sha256}` encoded in the standard tool text envelope.

- [ ] Write tests registering the tool with `CICY_ELECTRON_INJECT_DIR` set to a temporary directory. Assert install, status, replacement, mode `0600`, SHA-256, uninstall, traversal rejection, extension rejection, symlink rejection, and the 1 MiB limit.
- [ ] Run `node --test test/electron-inject-tools.test.js` and confirm RED because the tool does not exist.
- [ ] Implement `electron-inject-tools.js` with exported validation helpers and `registerTools`; resolve and realpath-check the fixed root, use `openSync(temp,"wx",0o600)`, `writeFileSync`, `renameSync`, and clean the temp on errors.
- [ ] Register it in `src/tools/index.js` and add `electron_inject` to the RPC guard's host-write list.
- [ ] Run the focused test, full `node --test test/*.test.js`, and `git diff --check`.
- [ ] Commit, fetch/rebase, and push `cicy-ai/cicy-desktop` `main`.

### Task 2: Public `agent-electron inject` CLI

**Files:**
- Modify: `skills/agent-electron/bin/agent-electron`
- Modify: `skills/agent-electron/manifest.json`
- Modify: `skills/agent-electron/SKILL.md`
- Modify: `skills/agent-electron/README.md`
- Modify: `skills/agent-electron/references/help.md`
- Modify: `skills/agent-electron/references/help.en.md`
- Modify: `skills/agent-electron/references/help.cn.md`
- Modify: `skills/agent-electron/references/tools.md`
- Modify: `skills/agent-electron/references/tools.en.md`
- Modify: `skills/agent-electron/references/tools.cn.md`
- Modify: `skills/agent-electron/test/test.js`

**Interfaces:**
- Consumes: `inject install <name> --source <file>`, `inject status <name>`, and `inject uninstall <name>`.
- Produces: the unwrapped `electron_inject` Desktop result with no source content in stdout/stderr.

- [ ] Add CLI tests using a temporary source containing a sentinel secret and a fake local cicy-code HTTP server. Assert the RPC payload selects `electron_inject`, forwards content, and output never contains the sentinel.
- [ ] Run `node tools/test-skill.js skills/agent-electron` and confirm RED.
- [ ] Add the `inject` dispatcher and parser. Require `--source` only for install, read UTF-8 with a 1 MiB pre-check, then call `rpc("electron_inject", payload)`.
- [ ] Update help and metadata; bump `agent-electron` from `1.0.17` to `1.1.0` because this is backward-compatible functionality.
- [ ] Run the Skill test, validator, sensitive-path scan, and `git diff --check`.
- [ ] Commit, fetch/rebase, push `cicy-ai/cicy-skills` `main`, tag `agent-electron-v1.1.0`, and monitor the public release and registry.

### Task 3: Integration verification

**Files:**
- Verify both repositories at remote `main`.

**Interfaces:**
- Consumes: a running new Desktop plus `agent-electron@1.1.0`.
- Produces: local tests, releases, and registry evidence; live host installation only when a Desktop containing the new RPC is connected.

- [ ] Re-run both focused/full suites from clean `main` checkouts.
- [ ] Confirm Desktop commit is on remote `main`, Skill workflow succeeded, Release ZIP exists, and registry reports `agent-electron@1.1.0`.
- [ ] If no updated Desktop is connected, report live installation as pending instead of claiming it ran.
