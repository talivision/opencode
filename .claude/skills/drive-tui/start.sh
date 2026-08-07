#!/usr/bin/env bash
# Usage: start.sh [session-name]
# Launches the compiled opencode TUI in a detached tmux session against an
# isolated fake provider, so a driving session never touches the real config,
# real credentials, real sessions, or a real model.
#
# All tmux commands run on a DEDICATED tmux server socket (-L "$SOCKET"), fully
# isolated from the user's own tmux sessions. Override with OPENCODE_TMUX_SOCKET.
#
# Env:
#   BIN            path to the binary (default: the darwin-arm64 build in dist/)
#   PORT           fake provider port (default 5010)
#   WORK           scratch tree (default $TMPDIR/drive-tui-<session>)
#   PROVIDER       which harness provider to run: goal | subagent | permission
#                  (default: goal). Its scenario env vars still apply, e.g.
#                  REVIEWER_MODE for the goal provider.
#   TUI_COLS/ROWS  terminal size (default 170x48)
#   KEEP_WORK      set to 1 to leave the scratch tree behind after stop.sh
set -uo pipefail

SOCKET="${OPENCODE_TMUX_SOCKET:-claude-opencode}"
SESSION="${1:-tui-test}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

BIN="${BIN:-$ROOT/packages/opencode/dist/opencode-darwin-arm64/bin/opencode}"
PORT="${PORT:-5010}"
WORK="${WORK:-${TMPDIR:-/tmp}/drive-tui-$SESSION}"
PROVIDER="${PROVIDER:-goal}"
COLS="${TUI_COLS:-170}"
ROWS="${TUI_ROWS:-48}"

case "$PROVIDER" in
  goal | subagent | permission) ;;
  *) echo "PROVIDER must be goal, subagent or permission" >&2; exit 1 ;;
esac
PROVIDER_DIR="$ROOT/script/${PROVIDER}-harness"

if [ ! -x "$BIN" ]; then
  echo "no executable binary at $BIN" >&2
  echo "build one with: OPENCODE_VERSION=dev ./packages/opencode/script/build.ts --single --skip-install --skip-embed-web-ui" >&2
  exit 1
fi
command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

if tmux -L "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists. Kill it with stop.sh, or attach:"
  echo "  tmux -L $SOCKET attach -t $SESSION"
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK/home" "$WORK/proj"
cp "$PROVIDER_DIR/opencode.json" "$WORK/proj/opencode.json"
node -e 'const f=process.argv[1],p=process.argv[2],fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/4599|4699|4799/g,p))' \
  "$WORK/proj/opencode.json" "$PORT"

# A commit is required, not cosmetic: Project.resolve derives the project id
# from remote -> cache -> ROOT COMMIT, falling back to the shared "global" id,
# and global-project state is deliberately never persisted. A repo with no
# commits therefore behaves like a non-VCS directory — permission grants do not
# persist and auto-approvals are not audited — which silently invalidates any
# test of those features.
git init -q "$WORK/proj"
git -C "$WORK/proj" -c user.email=drive@example.com -c user.name=drive-tui \
  commit -q --allow-empty -m "drive-tui base"

PORT="$PORT" LOG="$WORK/provider.log" node "$PROVIDER_DIR/fake-provider.mjs" \
  >"$WORK/provider.out" 2>&1 &
echo $! >"$WORK/provider.pid"

# Poll for readiness instead of sleeping a fixed amount: a cold machine is
# slower than a warm one, and a fixed sleep is how the older harnesses became
# flaky.
for _ in $(seq 1 50); do
  if node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/v1/models").then(()=>process.exit(0)).catch(()=>process.exit(1))' "$PORT" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

tmux -L "$SOCKET" new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" -c "$WORK/proj" \
  "HOME=$WORK/home \
   XDG_DATA_HOME=$WORK/home/.local/share \
   XDG_CONFIG_HOME=$WORK/home/.config \
   XDG_CACHE_HOME=$WORK/home/.cache \
   OPENCODE_DISABLE_AUTOUPDATE=1 \
   '$BIN' --pure 2>&1 | tee $WORK/tui.log"

echo "$WORK" >"${TMPDIR:-/tmp}/drive-tui-$SESSION.work"

# Wait for the prompt to actually render rather than guessing.
ready=0
for _ in $(seq 1 60); do
  if tmux -L "$SOCKET" capture-pane -p -t "$SESSION" 2>/dev/null | grep -q "Ask anything"; then
    ready=1
    break
  fi
  sleep 0.5
done

echo "Started '$SESSION' (${COLS}x${ROWS}) on tmux socket '$SOCKET' with the $PROVIDER provider on :$PORT"
echo "Scratch tree: $WORK   (project: $WORK/proj, log: $WORK/tui.log, provider log: $WORK/provider.log)"
if [ "$ready" = "1" ]; then
  echo "TUI is ready."
else
  echo "WARNING: the prompt did not render within 30s — capture the pane to see what happened." >&2
fi
echo ""
echo "  ./capture.py $SESSION /tmp/before.json"
echo "  ./send_keys.sh $SESSION Escape"
echo "  ./stop.sh $SESSION"
