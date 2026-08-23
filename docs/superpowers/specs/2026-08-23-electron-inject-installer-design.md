# Electron Inject Installer Design

## Goal

Allow a Skill running outside the desktop host, including inside WSL Docker, to install and manage an Electron Desktop Client injection script at:

```text
~/data/electron/extension/inject/telegram.org.js
```

The interface must not expose arbitrary host filesystem writes.

## Desktop Tool

Add an `electron_inject` RPC tool with three operations:

- `install`: accept a safe filename and UTF-8 JavaScript content, write it atomically, set file mode `0600`, and return path, byte size, and SHA-256.
- `status`: return existence, path, byte size, and SHA-256 without returning file content.
- `uninstall`: remove the named file and report whether it existed.

Resolve the root from `os.homedir()` plus `data/electron/extension/inject`. Accept only a basename matching `^[a-z0-9][a-z0-9._-]*\.js$`; reject separators, traversal, symlinks, non-JavaScript names, and targets outside the fixed root. Write to a temporary sibling with exclusive creation, rename atomically, and reject payloads larger than 1 MiB.

Register the tool in the normal Desktop tool catalog and classify it as a guarded host-write operation. Audit logging remains handled by the existing RPC guard.

## Public Skill Interface

Extend the public `agent-electron` Skill with:

```text
agent-electron inject install telegram.org.js --source <file>
agent-electron inject status telegram.org.js
agent-electron inject uninstall telegram.org.js
```

The CLI reads `--source` locally, sends content through the Desktop RPC, and never prints content. `install` requires an explicit source file; no WSL Hook or generated placeholder is substituted for the Mac injection script. JSON output preserves Desktop path, size, and SHA-256.

## Testing

- Desktop unit tests use a temporary home/root override and prove fixed-root resolution, safe-name validation, traversal rejection, size limit, atomic replacement, hash reporting, mode `0600`, status, and uninstall.
- `agent-electron` tests use a fake RPC transport and prove argv parsing, source reading, content forwarding without output leakage, stable JSON, and error handling.
- Existing Desktop and Skill suites must remain green.

## Release

Commit and push Desktop independently after its tests pass. Then bump and publish `agent-electron` with a tag-driven public Skill release. A Desktop application release is a separate explicit step because packaging and distributing a new Desktop binary affects all clients.
