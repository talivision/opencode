#!/bin/sh
# Post-session teardown for the generic drive-tui skill.
#
# Runs after the tmux session is killed and BEFORE the skill deletes
# $DRIVE_TUI_WORK, so this only has to deal with what the skill cannot know
# about: the fake provider process. The ~165MB scratch tree is the skill's job.
#
# Leaking either is how a long driving session fills the disk, and a full disk
# produces a flood of bogus test failures that look exactly like real ones.
if [ -f "$DRIVE_TUI_WORK/provider.pid" ]; then
  pid="$(cat "$DRIVE_TUI_WORK/provider.pid")"
  if kill "$pid" 2>/dev/null; then
    echo "reaped fake provider pid $pid"
  else
    echo "fake provider pid $pid already gone"
  fi
fi
