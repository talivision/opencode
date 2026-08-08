#!/bin/sh
# Pre-launch setup for the generic drive-tui skill.
#
# Contract (see ~/.claude/skills/drive-tui/SKILL.md):
#   in : DRIVE_TUI_WORK (an empty scratch dir the skill owns and deletes),
#        DRIVE_TUI_SESSION, DRIVE_TUI_PROJECT, DRIVE_TUI_SKILL; cwd = repo root
#   out: KEY=value lines on stdout become $VARS in .drive-tui.json and are
#        exported to the app. Everything else goes to stderr.
#   a non-zero exit aborts the launch and the skill removes the scratch tree.
#
# Env knobs:
#   BIN       path to the binary   (default: the darwin-arm64 build in dist/)
#   PROVIDER  goal | subagent | permission   (default: goal)
#   PORT      fake provider port   (default: 5307)
# Provider scenario vars pass straight through, e.g. REVIEWER_MODE=not_met.
set -eu

ROOT="${DRIVE_TUI_PROJECT:-$(pwd)}"
BIN="${BIN:-$ROOT/packages/opencode/dist/opencode-darwin-arm64/bin/opencode}"
PROVIDER="${PROVIDER:-goal}"
PORT="${PORT:-5307}"
WORK="$DRIVE_TUI_WORK"

case "$PROVIDER" in
  goal | subagent | permission) ;;
  *) echo "PROVIDER must be goal, subagent or permission" >&2; exit 1 ;;
esac
PROVIDER_DIR="$ROOT/script/${PROVIDER}-harness"

[ -x "$BIN" ] || {
  echo "no executable binary at $BIN" >&2
  echo "build one with: OPENCODE_VERSION=dev ./packages/opencode/script/build.ts --single --skip-install --skip-embed-web-ui" >&2
  exit 1
}
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

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

# Poll for the provider instead of sleeping a fixed amount: a cold machine is
# slower than a warm one, and a fixed sleep is how the older harnesses became
# flaky. The skill's own `ready` predicate covers the TUI; this covers the
# dependency the TUI needs before it can render.
i=0
until node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/v1/models").then(()=>process.exit(0)).catch(()=>process.exit(1))' "$PORT" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 50 ]; then
    echo "fake provider never answered on :$PORT" >&2
    cat "$WORK/provider.out" >&2
    exit 1
  fi
  sleep 0.2
done
echo "fake $PROVIDER provider up on :$PORT (pid $(cat "$WORK/provider.pid"))" >&2

echo "BIN=$BIN"
echo "PORT=$PORT"
echo "PROVIDER=$PROVIDER"
