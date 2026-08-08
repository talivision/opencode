#!/usr/bin/env bash
# Drive a compiled OpenCode binary through a goal-mode scenario against an
# isolated fake OpenAI-compatible provider, inside a dedicated tmux socket.
#
# Nothing here touches the real HOME, the real provider credentials, or the
# user's session storage: HOME/XDG are redirected into a scratch tree that is
# recreated on every run.
#
#   ./script/goal-harness/drive.sh <scenario> [seconds]
#
# Scenarios (see fake-provider.mjs REVIEWER_MODE):
#   met       reviewer accepts immediately            -> Goal achieved, 62 tokens
#   not_met   reviewer rejects once, then accepts     -> "Goal not yet met... continuing"
#   met_tool      reviewer accepts via goal_verdict tool  -> Goal achieved
#   not_met_tool  reviewer rejects via tool, then accepts -> "Goal not yet met... continuing"
#   retrieval reviewer builds a checklist, pulls evidence through goal_transcript,
#             rejects with per-requirement verdicts, then inherits the checklist
#             on attempt 2 and accepts. Asserted by assert-retrieval.mjs.
#   not_met_history reviewer rejects twice for different reasons, then accepts;
#             asserts both reasons reach worker request 3 under the anti-cycling heading
#   turns    one worker turn calls glob twice, then answers; durable turns must be 1
#   interrupted worker request 1 gets a non-retryable 400, is not reviewed, and resumes
#   cache-stable one interrupted worker turn is followed before any review by a recovered
#             turn with two glob steps; system messages stay byte-identical across that
#             turn boundary and within the recovered turn
#   goal-events reviewer accepts; asserts the rendered Goal achieved indication and durable completion
#   invalid   verdict carries the wrong nonce         -> forged verdict must be refused
#   http500   provider fails the reviewer request     -> reviewer failure inline
#   silent    reviewer never responds                 -> inactivity timeout
#   busy      reviewer streams forever                -> must survive inactivity, hit hard max
#   slow      reviewer streams every 20s, then MET    -> must survive inactivity
#
# Useful overrides:
#   BIN=... path to the binary (default: the darwin-arm64 build in dist/)
#   OBJECTIVE=... the goal text
#   TIMEOUT_MS / MAX_MS  -> OPENCODE_GOAL_REVIEW_{TIMEOUT,MAX}_MS
#   REVIEW_CONFIG='{"timeout":5000}' -> goal.review in the project opencode.json,
#     for exercising the config fallback with no env override present
set -euo pipefail

SCENARIO="${1:-not_met}"
WATCH="${2:-30}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

BIN="${BIN:-$ROOT/packages/opencode/dist/opencode-darwin-arm64/bin/opencode}"
OBJECTIVE="${OBJECTIVE:-Return control at least twice after saying lima once per turn.}"
PORT="${PORT:-4599}"
WORK="${WORK:-${TMPDIR:-/tmp}/opencode-goal-harness}"
SOCK="${SOCK:-/tmp/opencode-goal-harness.sock}"

case "$SCENARIO" in
  met | not_met | met_tool | not_met_tool | retrieval | not_met_history | turns | interrupted | cache-stable | goal-events | invalid | http500 | silent | busy | slow) ;;
  *)
    echo "usage: $0 <met|not_met|met_tool|not_met_tool|retrieval|not_met_history|turns|interrupted|cache-stable|goal-events|invalid|http500|silent|busy|slow> [seconds]" >&2
    exit 2
    ;;
esac

if [ ! -x "$BIN" ]; then
  echo "no binary at $BIN" >&2
  echo "build one with: OPENCODE_VERSION=dev ./packages/opencode/script/build.ts --single --skip-install --skip-embed-web-ui" >&2
  exit 1
fi
command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }

cleanup() {
  tmux -S "$SOCK" kill-server 2>/dev/null || true
  [ -f "$WORK/provider.pid" ] && kill "$(cat "$WORK/provider.pid")" 2>/dev/null || true
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$WORK/home" "$WORK/proj" "$WORK/snaps"
cp "$HERE/opencode.json" "$WORK/proj/opencode.json"
if [ "$PORT" != "4599" ]; then
  node -e 'const f=process.argv[1],p=process.argv[2],fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("4599",p))' \
    "$WORK/proj/opencode.json" "$PORT"
fi
if [ -n "${REVIEW_CONFIG:-}" ]; then
  node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.goal={review:JSON.parse(process.argv[2])};fs.writeFileSync(f,JSON.stringify(c,null,2))' \
    "$WORK/proj/opencode.json" "$REVIEW_CONFIG"
  echo "==> goal.review config: $REVIEW_CONFIG"
fi

echo "==> fake provider (:$PORT, REVIEWER_MODE=$SCENARIO)"
PORT="$PORT" \
LOG="$WORK/provider.log" \
WORKER_TEXT="${WORKER_TEXT:-Lima}" \
WORKER_INPUT="${WORKER_INPUT:-9000}" \
WORKER_OUTPUT="${WORKER_OUTPUT:-4}" \
REVIEWER_INPUT="${REVIEWER_INPUT:-12000}" \
REVIEWER_OUTPUT="${REVIEWER_OUTPUT:-58}" \
REVIEWER_MODE="$SCENARIO" \
REVIEWER_NOT_MET_N="${REVIEWER_NOT_MET_N:-1}" \
  node "$HERE/fake-provider.mjs" >"$WORK/provider.out" 2>&1 &
echo $! >"$WORK/provider.pid"
sleep 1
cat "$WORK/provider.out"

echo "==> $("$BIN" --version) in tmux ($SOCK)"
tmux -S "$SOCK" kill-server 2>/dev/null || true
tmux -S "$SOCK" new-session -d -x 160 -y 45 -s goal -c "$WORK/proj" \
  "HOME=$WORK/home \
   XDG_DATA_HOME=$WORK/home/.local/share \
   XDG_CONFIG_HOME=$WORK/home/.config \
   XDG_CACHE_HOME=$WORK/home/.cache \
   OPENCODE_DISABLE_AUTOUPDATE=1 \
   ${TIMEOUT_MS:+OPENCODE_GOAL_REVIEW_TIMEOUT_MS=$TIMEOUT_MS} \
   ${MAX_MS:+OPENCODE_GOAL_REVIEW_MAX_MS=$MAX_MS} \
   '$BIN' --pure 2>&1 | tee $WORK/tui.log"

sleep 15
tmux -S "$SOCK" capture-pane -p -t goal >"$WORK/snaps/00-startup.txt"

echo "==> /goal $OBJECTIVE"
tmux -S "$SOCK" send-keys -t goal "/goal $OBJECTIVE"
sleep 1
tmux -S "$SOCK" send-keys -t goal Enter

if [ "$SCENARIO" = "interrupted" ]; then
  # A later clean turn intentionally clears goal.interrupted. Capture the
  # durable record while the provider's finite recovery stream is in flight.
  for ((attempt = 0; attempt < 60; attempt++)); do
    state="$(ls "$WORK/home/.local/share/opencode/storage/goal/"*.json 2>/dev/null | head -1 || true)"
    if [ -n "$state" ] && node -e 'const fs=require("fs");const state=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(state.interrupted?.count===1?0:1)' "$state"; then
      cp "$state" "$WORK/interrupted-goal.json"
      break
    fi
    sleep 0.1
  done
fi

elapsed=0
while [ "$elapsed" -lt "$WATCH" ]; do
  sleep 5
  elapsed=$((elapsed + 5))
  tmux -S "$SOCK" capture-pane -p -t goal >"$WORK/snaps/$(printf %03d $elapsed).txt"
  echo "--- +${elapsed}s"
  tmux -S "$SOCK" capture-pane -p -t goal \
    | grep -E "Independent review|Goal (achieved|not yet met|active|complete|paused|blocked)|could not finish" \
    | head -6 || true
done

echo
echo "==> durable goal state"
cat "$WORK/home/.local/share/opencode/storage/goal/"*.json 2>/dev/null || echo "(none)"
echo "==> snapshots: $WORK/snaps"
echo "==> provider request log: $WORK/provider.log"

if [ "$SCENARIO" = "retrieval" ]; then
  echo "==> retrieval assertions"
  DB="$(ls "$WORK/home/.local/share/opencode/"*.db 2>/dev/null | head -1 || true)"
  node "$HERE/assert-retrieval.mjs" \
    "$WORK/provider.log" \
    "${DB:-}" \
    "$WORK/home/.local/share/opencode/storage/goal"
fi

case "$SCENARIO" in
  not_met_history | turns | interrupted | cache-stable | goal-events)
    echo "==> $SCENARIO assertions"
    DB="$(ls "$WORK/home/.local/share/opencode/"*.db 2>/dev/null | head -1 || true)"
    node "$HERE/assert-scenarios.mjs" \
      "$SCENARIO" \
      "$WORK/provider.log" \
      "${DB:-}" \
      "$WORK/home/.local/share/opencode/storage/goal" \
      "$WORK/snaps" \
      "$WORK/interrupted-goal.json"
    ;;
esac

if [ "$SCENARIO" = "cache-stable" ]; then
  echo "==> cache-stable cross-turn assertion"
  node -e '
const fs = require("fs")
const entries = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
const workers = entries.filter((entry) => entry.role === "worker")
const before = workers.find((entry) => entry.turn === 1)
const after = workers.find((entry) => entry.turn === 2)
const beforeAt = entries.indexOf(before)
const afterAt = entries.indexOf(after)
const system = (entry) => JSON.stringify(entry?.body?.messages?.filter((message) => message.role === "system") ?? [])
const continuation = JSON.stringify(after?.body ?? {})
const noReviewBetween = beforeAt >= 0 && afterAt > beforeAt && !entries.slice(beforeAt + 1, afterAt).some((entry) => entry.role === "reviewer")
const ok =
  before &&
  after &&
  noReviewBetween &&
  continuation.includes("Current active-goal status for this turn:") &&
  continuation.includes("GOAL_HARNESS_CACHE_TURN_BOUNDARY") &&
  system(before) === system(after)
console.log(`${ok ? "ok  " : "not ok"} the system message is byte-identical across the no-review worker-turn boundary`)
process.exit(ok ? 0 : 1)
' "$WORK/provider.log"
fi
