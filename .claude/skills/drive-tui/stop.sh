#!/usr/bin/env bash
# Usage:
#   stop.sh [session-name]   Kill a single session (default: tui-test)
#   stop.sh --all            Tear down the WHOLE dedicated tmux server
#
# All tmux commands run on a DEDICATED tmux server socket (-L "$SOCKET"),
# fully isolated from the user's default-socket sessions. Override the socket
# name with OPENCODE_TMUX_SOCKET (default: claude-opencode).
#
# Because the server is dedicated, `kill-server` on this socket is SAFE: it
# only affects sessions created by this skill, never the user's own tmux.

SOCKET="${OPENCODE_TMUX_SOCKET:-claude-opencode}"

# Each session owns a fake provider process and a ~165MB scratch tree. Leaving
# either behind is how a long driving session fills the disk and then produces
# a mass of bogus test failures that look like real ones.
cleanup_session() {
  local session="$1"
  local marker="${TMPDIR:-/tmp}/drive-tui-${session}.work"
  [ -f "$marker" ] || return 0
  local work
  work="$(cat "$marker")"
  if [ -f "$work/provider.pid" ]; then
    kill "$(cat "$work/provider.pid")" 2>/dev/null
  fi
  if [ "${KEEP_WORK:-0}" = "1" ]; then
    echo "Kept scratch tree: $work"
  else
    rm -rf "$work"
  fi
  rm -f "$marker"
}

if [ "$1" = "--all" ]; then
  for marker in "${TMPDIR:-/tmp}"/drive-tui-*.work; do
    [ -e "$marker" ] || continue
    base="$(basename "$marker" .work)"
    cleanup_session "${base#drive-tui-}"
  done
  if tmux -L "$SOCKET" kill-server 2>/dev/null; then
    echo "Killed the entire dedicated tmux server (socket '$SOCKET')"
  else
    echo "No dedicated tmux server running (socket '$SOCKET')"
  fi
  exit 0
fi

SESSION="${1:-tui-test}"

cleanup_session "$SESSION"

if tmux -L "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  tmux -L "$SOCKET" kill-session -t "$SESSION"
  echo "Killed session '$SESSION' (socket '$SOCKET')"
else
  echo "No session '$SESSION' found (socket '$SOCKET')"
fi
