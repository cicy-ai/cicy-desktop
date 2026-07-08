#!/bin/bash
# Vendored copy pushed INTO the running container by cicy-desktop at update time
# (see wsl-docker.js update()), then executed. This is the authoritative script
# for the "更新 cicy-code" flow: shipping a fix here rides cicy-desktop's own
# auto-update (OSS, reaches Windows) — NO new container image / pull required,
# which is why we cp-then-run instead of relying on the baked image copy.
#
# Hot-update cicy-code WITHOUT bouncing the container, the cloudflared tunnel,
# or any user daemons: install the new version side-by-side, repoint one symlink,
# restart only the supervisor program.
#
#   cicy-code-update            # → latest
#   cicy-code-update 2.3.16     # → a pinned version
set -euo pipefail

HOME_DIR="${HOME:-/home/cicy}"

# Registry selection: honor an explicit NPM_REGISTRY (cicy-desktop injects it via
# `docker exec -e` per host network) — otherwise probe registry.npmjs.org with a
# short timeout: reachable fast → official npm (best overseas); slow/blocked →
# registry.npmmirror.com (CN mirror, the safe default).
NPM_OFFICIAL="https://registry.npmjs.org"
NPM_CN="https://registry.npmmirror.com"
pick_registry() {
  if [ -n "${NPM_REGISTRY:-}" ]; then echo "$NPM_REGISTRY"; return; fi
  if curl -fsS -m 3 --connect-timeout 3 -o /dev/null "$NPM_OFFICIAL/cicy-code"; then
    echo "$NPM_OFFICIAL"
  else
    echo "$NPM_CN"
  fi
}
REG="$(pick_registry)"
# cicy-code's binary tree now lives under ~/.local/cicy-code/<ver>/, matching
# cicy-code v2.3.193+ (api/cicy-code-update.sh). CICY_CODE_STORE overrides it.
# versions.json deliberately STAYS under ~/cicy-ai/runtime — it's the SHARED
# pointer the container's mihomo store & the Go server also read; only the
# cicy-code binary tree moved off runtime.
RT="${CICY_CODE_STORE:-$HOME_DIR/.local/cicy-code}"
LINK="$HOME_DIR/.local/bin/cicy-code"
VERSIONS="$HOME_DIR/cicy-ai/runtime/versions.json"
SVCTL="supervisorctl -c /etc/supervisor/supervisord.conf"

want="${1:-latest}"
log() { printf '[cicy-code-update] %s\n' "$*"; }
log "registry: $REG"

# Resolve the concrete version number (so the install dir is version-named and
# re-runs are idempotent / cacheable).
if printf '%s' "$want" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
  # Caller (cicy-desktop) already resolved a concrete version on the HOST (fast,
  # reliable network) → trust it, skip the in-container `npm view` entirely. This
  # is the path that avoids the ~2min npm-view hang on a slow container registry.
  ver="$want"
else
  # 'latest' / range → resolve via registry. FAIL FAST: npm's default retry/backoff
  # can burn ~2min on a slow/blocked registry — cap retries+timeout so one bad
  # registry fails in ~15s, then fall back to the other registry instead of hanging.
  resolve_ver() {
    npm view "cicy-code@${want}" version --registry "$1" \
      --fetch-retries=1 --fetch-timeout=15000 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=15000 \
      2>/dev/null | tail -n1
  }
  ver="$(resolve_ver "$REG")"
  if [ -z "$ver" ]; then
    alt="$NPM_CN"; [ "$REG" = "$NPM_CN" ] && alt="$NPM_OFFICIAL"
    log "registry $REG slow/unreachable → falling back to $alt"
    ver="$(resolve_ver "$alt")"
    [ -n "$ver" ] && REG="$alt"
  fi
fi
[ -n "$ver" ] || { log "could not resolve cicy-code@${want}"; exit 1; }
dest="$RT/$ver"

if [ -x "$dest/bin/cicy-code" ]; then
  log "v$ver already installed → repointing"
else
  log "installing v$ver from $REG"
  rm -rf "$dest"
  mkdir -p "$dest"
  npm install -g "cicy-code@$ver" --prefix "$dest" --registry "$REG" \
    --fetch-retries=2 --fetch-timeout=60000 --fetch-retry-maxtimeout=30000
fi

mkdir -p "$(dirname "$LINK")"
ln -sfn "$dest/bin/cicy-code" "$LINK"
# Keep the npm-global bin (first on PATH) following the canonical link too, so
# interactive `cicy-code` matches what supervisor runs.
ln -sfn "$LINK" "$HOME_DIR/.npm-global/bin/cicy-code" 2>/dev/null || true

# Record current pointer (merge into the shared versions.json).
mkdir -p "$(dirname "$VERSIONS")"
tmp="$(mktemp)"
if [ -s "$VERSIONS" ] && jq -e . "$VERSIONS" >/dev/null 2>&1; then
  jq --arg v "$ver" '.["cicy-code"] = ((.["cicy-code"] // {}) + {current: $v})' "$VERSIONS" > "$tmp"
else
  jq -n --arg v "$ver" '{"cicy-code": {current: $v}}' > "$tmp"
fi
mv "$tmp" "$VERSIONS"

log "symlink → $(readlink -f "$LINK")"

# Reload: restart only this program (no-op gracefully if supervisord isn't up).
if $SVCTL pid >/dev/null 2>&1; then
  log "restarting via supervisor"
  $SVCTL restart cicy-code
else
  log "supervisord not running yet; symlink set, will start on boot"
fi
log "done → v$ver"
