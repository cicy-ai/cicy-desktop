#!/usr/bin/env bash
# Push a locally built CiCy Desktop installer to every Windows node and install
# it there — no CDN, no auto-update wait.
#
#   scripts/deploy-exe-fleet.sh [path/to/CiCy Desktop Setup X.Y.Z.exe] [node...]
#
# Per node (ssh alias from ~/.ssh/config, e.g. xs-1001 — frp via ws-hub):
#   1. scp the exe into the node's ~/projects (= C:\ of its Windows host)
#   2. ssh -L tunnel to the node's cicy-code :8008, ask it for connected
#      cicy-desktop clients (agent-desktop clients)
#   3. agent-desktop exec-file a tiny .bat on each Windows client that runs the
#      installer silently (/S). The installer closes the running desktop and
#      relaunches it; the client's ack may time out — that's expected.
#
# Env: NODES="xs-1001 xs-1002" to override discovery; LOCAL_PORT_BASE=18100.
set -uo pipefail
cd "$(dirname "$0")/.."

EXE=${1:-}
if [ -z "$EXE" ]; then
  EXE=$(ls -t ../cicy-desktop-win/dist/CiCy\ Desktop\ Setup\ *.exe 2>/dev/null | head -1)
fi
[ -f "$EXE" ] || { echo "installer not found: '$EXE'" >&2; exit 1; }
shift || true
VER=$(basename "$EXE" | sed -E 's/.*Setup ([0-9.]+)\.exe/\1/')
REMOTE_NAME="CiCy-Desktop-Setup-$VER.exe"
WIN_PATH="C:\\$REMOTE_NAME"

if [ $# -gt 0 ]; then NODES="$*"; fi
if [ -z "${NODES:-}" ]; then
  # every xs-* alias in ~/.ssh/config (Windows hosts); mac-local etc. are not exe targets
  NODES=$(awk '/^Host xs-/{print $2}' ~/.ssh/config | sort -V)
fi
PORT=${LOCAL_PORT_BASE:-18100}
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

cat > "$SCRATCH/install.bat" <<EOF
@echo off
if not exist "$WIN_PATH" (echo missing $WIN_PATH & exit /b 2)
start "" "$WIN_PATH" /S
echo started installer $VER
EOF

echo "installer: $EXE ($VER) -> $WIN_PATH"
echo "nodes: $(echo $NODES | tr '\n' ' ')"
ok=(); skipped=(); failed=()
for n in $NODES; do
  echo "== $n"
  if ! timeout 20 ssh -n -o ConnectTimeout=10 -o BatchMode=yes "$n" true 2>/dev/null; then
    echo "   offline, skipped"; skipped+=("$n"); continue
  fi
  if ! timeout 600 scp -q -o ConnectTimeout=15 "$EXE" "$n:projects/$REMOTE_NAME"; then
    echo "   scp failed"; failed+=("$n(scp)"); continue
  fi
  echo "   copied to $WIN_PATH"
  TOKEN=$(timeout 30 ssh -n "$n" 'python3 -c "import json;print(json.load(open(\"/home/cicy/cicy-ai/global.json\")).get(\"api_token\",\"\"))"' 2>/dev/null | tail -1)
  if [ -z "$TOKEN" ]; then echo "   no api token"; failed+=("$n(token)"); continue; fi
  PORT=$((PORT+1))
  ssh -f -N -o ExitOnForwardFailure=yes -o ConnectTimeout=15 -L "$PORT:127.0.0.1:8008" "$n" 2>/dev/null || { echo "   tunnel failed"; failed+=("$n(tunnel)"); continue; }
  sleep 1
  CLIENTS=$(CICY_API_PORT=$PORT CICY_API_TOKEN="$TOKEN" timeout 40 agent-desktop clients --json 2>/dev/null \
    | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
except Exception:
  sys.exit(0)
rows=d if isinstance(d,list) else (d.get("clients") or d.get("data") or [])
for c in rows:
  if not isinstance(c,dict): continue
  cid=c.get("client_id") or c.get("clientId") or c.get("id")
  plat=str(c.get("platform") or "")
  if cid and (plat.startswith("win") or not plat): print(cid)' )
  if [ -z "$CLIENTS" ]; then
    echo "   no cicy-desktop client connected on $n (exe left at $WIN_PATH)"; failed+=("$n(no-desktop)")
  else
    for c in $CLIENTS; do
      printf "   install on %s ... " "$c"
      out=$(CICY_API_PORT=$PORT CICY_API_TOKEN="$TOKEN" timeout 45 agent-desktop exec-file "$SCRATCH/install.bat" --client "$c" 2>&1 | tail -1)
      echo "${out:-sent}"
    done
    ok+=("$n")
  fi
  pkill -f -- "-L $PORT:127.0.0.1:8008 $n" 2>/dev/null
done
echo
echo "installed/sent: ${ok[*]:-none}"
echo "skipped (offline): ${skipped[*]:-none}"
echo "failed: ${failed[*]:-none}"
