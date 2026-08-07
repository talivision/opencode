#!/usr/bin/env bash
# Usage: send_keys.sh [session] <keys...>
# Sends keystrokes to the tmux session. Keys are passed as separate args,
# each sent as one tmux send-keys call (so special names like 'Enter',
# 'Up', 'Down', 'Escape', 'BSpace' work correctly).
#
# All tmux commands run on a DEDICATED tmux server socket (-L "$SOCKET"),
# fully isolated from the user's default-socket sessions. Override the socket
# name with OPENCODE_TMUX_SOCKET (default: claude-opencode).
#
# Examples:
#   send_keys.sh tui-test j j j
#   send_keys.sh tui-test / f o o Enter
#   send_keys.sh tui-test Escape
#   send_keys.sh tui-test 'C-c'

SOCKET="${OPENCODE_TMUX_SOCKET:-claude-opencode}"
SESSION="${1:-tui-test}"
shift

if ! tmux -L "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  echo "ERROR: No tmux session '$SESSION'." >&2
  exit 1
fi

for key in "$@"; do
  tmux -L "$SOCKET" send-keys -t "$SESSION" "$key" ""
  sleep 0.05
done

echo "Sent ${#@} key(s) to '$SESSION'"
