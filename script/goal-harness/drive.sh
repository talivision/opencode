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
#   unclaimed worker omits the goal tool once, receives a persisted reminder,
#             then requests completion and is accepted by one structured review
#   retrieval reviewer builds a checklist, pulls evidence through goal_transcript,
#             rejects with per-requirement verdicts, then inherits the checklist
#             on attempt 2 and accepts. Asserted by assert-retrieval.mjs.
#   not_met_history reviewer rejects twice for different reasons, then accepts;
#             asserts both reasons reach a later worker request under the anti-cycling heading
#   turns    one worker turn calls glob twice, then answers; durable turns must be 1
#   interrupted worker request 1 gets a non-retryable 400, is not reviewed, and resumes
#   cache-stable one interrupted worker turn is followed before any review by a recovered
#             turn with two glob steps; system messages stay byte-identical across that
#             turn boundary and within the recovered turn
#   goal-events reviewer accepts; asserts the rendered Goal achieved indication and durable completion
#   invalid   verdict carries the wrong nonce         -> forged verdict must be refused
#   http500   provider fails the reviewer request     -> reviewer failure inline
#   silent    reviewer never responds                 -> inactivity timeout
#   permission_blocked reviewer waits on an external-directory permission beyond
#             both 5s watchdog limits, then accepts after the UI grants it
#   goal_check reviewer runs one exact configured command, refuses a prefix
#             near-miss, sees both results, and submits an accepted verdict
#   busy      reviewer streams forever                -> must survive inactivity, hit hard max
#   slow      reviewer streams every 20s, then MET    -> must survive inactivity
#   soak      six unclaimed worker turns exercise reminder backoff, then one slow
#             tool-based review completes; watches pacing and TUI health for ~8 minutes
#   ux_goal_window worker never claims completion; drives goal minimize/expand and pane assertions
#   ux_queued_cancel worker claims completion, slow review stays busy while a queued message is cancelled
#   ux_search worker replies with two searchable texts; drives leader+f and /find, counter cycling, escape
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
if [ "$SCENARIO" = "soak" ] && [ "$#" -lt 2 ]; then
  WATCH=480
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

BIN="${BIN:-$ROOT/packages/opencode/dist/opencode-darwin-arm64/bin/opencode}"
OBJECTIVE="${OBJECTIVE:-Return control at least twice after saying lima once per turn.}"
LONG_OBJECTIVE="Amber cartographers carefully trace winding rivers through forgotten valleys while patient engineers compare every landmark, verify each bridge, document unusual weather, and preserve clear notes so future explorers can reproduce the journey, inspect hidden assumptions, correct subtle mistakes, and finally reach the distant observatory beneath a brilliant winter constellation named Zephyr."
OBJECTIVE_ROW_PATTERN="Amber|cartographers|carefully|trace|winding|rivers|forgotten|valleys|patient|engineers|landmark|bridge|document|unusual|weather|preserve|notes|future|explorers|reproduce|journey|inspect|hidden|assumptions|correct|subtle|mistakes|finally|distant|observatory|brilliant|winter|constellation|Zephyr"
QUEUED_MESSAGE="cancel me before the review finishes"
PORT="${PORT:-4599}"
WORK="${WORK:-${TMPDIR:-/tmp}/opencode-goal-harness}"
SOCK="${SOCK:-/tmp/opencode-goal-harness.sock}"

if [ "$SCENARIO" = "ux_goal_window" ]; then
  OBJECTIVE="$LONG_OBJECTIVE"
  # Long worker replies double as the word-wrap regression fixture: a row-flex
  # sibling next to <markdown> once clipped output to a single line.
  WORKER_TEXT="${WORKER_TEXT:-The assistant reply fixture is intentionally a very long single paragraph so that any regression in markdown word wrapping inside the transcript surfaces as a clipped single row instead of a wrapped block spanning multiple rows}"
  export WORKER_TEXT
fi

case "$SCENARIO" in
  met | not_met | met_tool | not_met_tool | unclaimed | retrieval | not_met_history | turns | interrupted | cache-stable | goal-events | invalid | http500 | silent | permission_blocked | goal_check | busy | slow | soak | ux_goal_window | ux_queued_cancel | ux_search) ;;
  *)
    echo "usage: $0 <met|not_met|met_tool|not_met_tool|unclaimed|retrieval|not_met_history|turns|interrupted|cache-stable|goal-events|invalid|http500|silent|permission_blocked|goal_check|busy|slow|soak|ux_goal_window|ux_queued_cancel|ux_search> [seconds]" >&2
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

failures=0
ux_ok() {
  echo "ok  $1"
}
ux_fail() {
  echo "not ok $1${2:+ — $2}"
  failures=$((failures + 1))
}

capture_goal_pane() {
  tmux -S "$SOCK" capture-pane -p -t goal >"$1"
}

wait_for_goal_text() {
  local text="$1"
  local snapshot="$2"
  while [ "$SECONDS" -lt "$UX_DEADLINE" ]; do
    capture_goal_pane "$snapshot"
    if grep -Fq "$text" "$snapshot"; then
      return
    fi
    sleep 0.25
  done
  capture_goal_pane "$snapshot"
  return 1
}

wait_for_goal_pair() {
  local first="$1"
  local second="$2"
  local snapshot="$3"
  while [ "$SECONDS" -lt "$UX_DEADLINE" ]; do
    capture_goal_pane "$snapshot"
    if grep -Fq "$first" "$snapshot" && grep -Fq "$second" "$snapshot"; then
      return
    fi
    sleep 0.25
  done
  capture_goal_pane "$snapshot"
  return 1
}

wait_for_goal_regex() {
  local regex="$1"
  local snapshot="$2"
  while [ "$SECONDS" -lt "$UX_DEADLINE" ]; do
    capture_goal_pane "$snapshot"
    if grep -Eq "$regex" "$snapshot"; then
      return
    fi
    sleep 0.25
  done
  capture_goal_pane "$snapshot"
  return 1
}

wait_for_queued_message() {
  local snapshot="$1"
  while [ "$SECONDS" -lt "$UX_DEADLINE" ]; do
    capture_goal_pane "$snapshot"
    if grep -Fq "$QUEUED_MESSAGE" "$snapshot" && grep -Fq "QUEUED" "$snapshot"; then
      return
    fi
    sleep 0.25
  done
  capture_goal_pane "$snapshot"
  return 1
}

wait_for_cancelled_message() {
  local snapshot="$1"
  while [ "$SECONDS" -lt "$UX_DEADLINE" ]; do
    capture_goal_pane "$snapshot"
    # The cancelled text legitimately reappears in the composer (restore),
    # so completion is dialog-gone + badge-gone, not text-gone.
    if ! grep -Fq "Message Actions" "$snapshot" &&
      ! grep -Fq "QUEUED" "$snapshot"; then
      return
    fi
    sleep 0.25
  done
  capture_goal_pane "$snapshot"
  return 1
}

cleanup() {
  tmux -S "$SOCK" kill-server 2>/dev/null || true
  [ -f "$WORK/provider.pid" ] && kill "$(cat "$WORK/provider.pid")" 2>/dev/null || true
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$WORK/home" "$WORK/proj" "$WORK/snaps"
cp "$HERE/opencode.json" "$WORK/proj/opencode.json"
REVIEWER_READ_PATH="$(cd "$WORK" && pwd)/reviewer-outside.txt"
printf '%s\n' 'GOAL_HARNESS_PERMISSION_APPROVED' >"$REVIEWER_READ_PATH"
node -e '
const fs = require("fs")
const file = process.argv[1]
const port = process.argv[2]
const scenario = process.argv[3]
const config = JSON.parse(fs.readFileSync(file, "utf8"))
config.provider.fake.options.baseURL = `http://127.0.0.1:${port}/v1`
if (["permission_blocked", "silent"].includes(scenario)) {
  config.goal = { ...config.goal, review: { ...config.goal?.review, timeout: 5000 } }
}
if (scenario === "permission_blocked") {
  config.goal.review.max_duration = 5000
  config.agent = {
    ...config.agent,
    "goal-reviewer": {
      ...config.agent?.["goal-reviewer"],
      permission: {
        ...config.agent?.["goal-reviewer"]?.permission,
        external_directory: { "*": "ask" },
      },
    },
  }
}
if (scenario === "silent") config.goal.review.max_duration = 20000
if (scenario === "goal_check") {
  config.goal = {
    ...config.goal,
    review: { ...config.goal?.review, commands: ["printf goal-check-ok"] },
  }
}
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
' "$WORK/proj/opencode.json" "$PORT" "$SCENARIO"
if [ -n "${REVIEW_CONFIG:-}" ]; then
  node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.goal={...c.goal,review:{...c.goal?.review,...JSON.parse(process.argv[2])}};fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' \
    "$WORK/proj/opencode.json" "$REVIEW_CONFIG"
  echo "==> goal.review config: $REVIEW_CONFIG"
fi

# unclaimed asserts a single accepted review attempt, so its reviewer must
# accept on the first verdict rather than inheriting the NOT_MET-once default.
if [ "$SCENARIO" = "unclaimed" ]; then
  REVIEWER_NOT_MET_N="${REVIEWER_NOT_MET_N:-0}"
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
REVIEWER_READ_PATH="$REVIEWER_READ_PATH" \
  node "$HERE/fake-provider.mjs" >"$WORK/provider.out" 2>&1 &
echo $! >"$WORK/provider.pid"
sleep 1
cat "$WORK/provider.out"

echo "==> $("$BIN" --version) in tmux ($SOCK)"
tmux -S "$SOCK" kill-server 2>/dev/null || true
PANE_ROWS="$([ "$SCENARIO" = "ux_goal_window" ] && echo 50 || echo 45)"
tmux -S "$SOCK" new-session -d -x 160 -y "$PANE_ROWS" -s goal -c "$WORK/proj" \
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
if [[ "$SCENARIO" = ux_* ]]; then
  tmux -S "$SOCK" send-keys -l -t goal -- "/goal $OBJECTIVE"
else
  tmux -S "$SOCK" send-keys -t goal "/goal $OBJECTIVE"
  sleep 1
fi
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

if [ "$SCENARIO" = "ux_goal_window" ]; then
  UX_WINDOW="$WATCH"
  if [ "$UX_WINDOW" -gt 45 ]; then
    UX_WINDOW=45
  fi
  UX_DEADLINE=$((SECONDS + UX_WINDOW))

  echo "==> wait for expanded goal window"
  wait_for_goal_pair "◎ Goal active" "ctrl+x z minimize" "$WORK/snaps/ux-goal-expanded.txt" || true

  echo "==> minimize goal window"
  tmux -S "$SOCK" send-keys -t goal C-x
  tmux -S "$SOCK" send-keys -t goal z
  wait_for_goal_text "ctrl+x z expand" "$WORK/snaps/ux-goal-minimized.txt" || true

  echo "==> expand goal window"
  tmux -S "$SOCK" send-keys -t goal C-x
  tmux -S "$SOCK" send-keys -t goal z
  wait_for_goal_text "ctrl+x z minimize" "$WORK/snaps/ux-goal-reexpanded.txt" || true
elif [ "$SCENARIO" = "ux_queued_cancel" ]; then
  UX_WINDOW="$WATCH"
  if [ "$UX_WINDOW" -gt 45 ]; then
    UX_WINDOW=45
  fi
  UX_DEADLINE=$((SECONDS + UX_WINDOW))

  echo "==> wait for slow independent review"
  wait_for_goal_regex "review running|Independent review" "$WORK/snaps/ux-review-running.txt" || true

  echo "==> queue message during review"
  tmux -S "$SOCK" send-keys -l -t goal -- "$QUEUED_MESSAGE"
  tmux -S "$SOCK" send-keys -t goal Enter
  wait_for_queued_message "$WORK/snaps/ux-queued-message.txt" || true

  queued_row="$(grep -nF "cancel me before" "$WORK/snaps/ux-queued-message.txt" | tail -1 | cut -d: -f1 || true)"
  if [ -n "$queued_row" ]; then
    echo "==> click queued message at row $queued_row"
    tmux -S "$SOCK" send-keys -t goal -- $'\e[<0;8;'"$queued_row"$'M'
    sleep 0.2
    tmux -S "$SOCK" send-keys -t goal -- $'\e[<0;8;'"$queued_row"$'m'
  fi
  wait_for_goal_text "Message Actions" "$WORK/snaps/ux-message-actions.txt" || true

  tmux -S "$SOCK" send-keys -t goal Enter
  wait_for_cancelled_message "$WORK/snaps/ux-message-cancelled.txt" || true
elif [ "$SCENARIO" = "ux_search" ]; then
  UX_WINDOW="$WATCH"
  if [ "$UX_WINDOW" -gt 45 ]; then
    UX_WINDOW=45
  fi
  UX_DEADLINE=$((SECONDS + UX_WINDOW))

  echo "==> wait for both searchable assistant replies"
  wait_for_goal_text "xylophone hummed" "$WORK/snaps/ux-search-transcript.txt" || true

  echo "==> open transcript search"
  tmux -S "$SOCK" send-keys -t goal C-x
  tmux -S "$SOCK" send-keys -t goal f
  wait_for_goal_text "Find in transcript" "$WORK/snaps/ux-search-open.txt" || true

  echo "==> search a term matching both replies"
  tmux -S "$SOCK" send-keys -l -t goal -- "the"
  wait_for_goal_text "2/2" "$WORK/snaps/ux-search-counter.txt" || true

  echo "==> cycle to the older match"
  tmux -S "$SOCK" send-keys -t goal Enter
  wait_for_goal_text "1/2" "$WORK/snaps/ux-search-cycled.txt" || true
  # The streaming markdown below the marker re-renders asynchronously after
  # the highlight moves; poll until the marker AND the matched text share a
  # settled frame.
  while [ "$SECONDS" -lt "$UX_DEADLINE" ]; do
    capture_goal_pane "$WORK/snaps/ux-search-cycled-marker.txt"
    if grep -A2 -F "▍ match" "$WORK/snaps/ux-search-cycled-marker.txt" | grep -Fq "amber zebra"; then
      break
    fi
    sleep 0.25
  done

  echo "==> close search"
  # "esc close" is the bar's stable marker; the placeholder vanishes as soon
  # as a query is typed, so polling on it declared victory with the bar open.
  UX_SEARCH_CLOSED=0
  for esc_try in 1 2 3; do
    tmux -S "$SOCK" send-keys -t goal Escape
    ESC_WAIT=$((SECONDS + 4))
    while [ "$SECONDS" -lt "$ESC_WAIT" ] && [ "$SECONDS" -lt "$UX_DEADLINE" ]; do
      capture_goal_pane "$WORK/snaps/ux-search-closed.txt"
      if ! grep -Fq "esc close" "$WORK/snaps/ux-search-closed.txt"; then
        UX_SEARCH_CLOSED=1
        break
      fi
      sleep 0.25
    done
    [ "$UX_SEARCH_CLOSED" -eq 1 ] && break
  done

  echo "==> reopen transcript search with /find"
  tmux -S "$SOCK" send-keys -l -t goal -- "/find"
  tmux -S "$SOCK" send-keys -t goal Enter
  wait_for_goal_text "esc close" "$WORK/snaps/ux-search-slash.txt" || true
elif [ "$SCENARIO" = "permission_blocked" ]; then
  echo "==> wait for reviewer permission block"
  blocked=0
  for ((attempt = 0; attempt < WATCH; attempt++)); do
    DB="$(ls "$WORK/home/.local/share/opencode/"*.db 2>/dev/null | head -1 || true)"
    state="$(ls "$WORK/home/.local/share/opencode/storage/goal/"*.json 2>/dev/null | head -1 || true)"
    tmux -S "$SOCK" capture-pane -p -t goal >"$WORK/snaps/permission-current.txt"
    if [ -n "$DB" ] && [ -n "$state" ] && \
      node -e 'const fs=require("fs");const goal=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(goal.review?.status==="running"?0:1)' "$state" && \
      [ "$(sqlite3 "$DB" "SELECT count(*) FROM part WHERE json_extract(data, '$.tool') = 'goal-review' AND json_extract(data, '$.state.status') = 'running' AND json_extract(data, '$.state.metadata.activity') = 'Waiting for permission approval';" 2>/dev/null || echo 0)" -gt 0 ] && \
      grep -Fq "Permission required" "$WORK/snaps/permission-current.txt"; then
      blocked=1
      break
    fi
    sleep 1
  done

  # Eight seconds is beyond both configured 5s limits. If either clock keeps
  # charging blocked time, the durable running part below becomes an error and
  # permission_blocked_pending fails before the UI approval is sent.
  sleep 8
  tmux -S "$SOCK" capture-pane -p -t goal >"$WORK/snaps/permission-after-window.txt"
  state="$(ls "$WORK/home/.local/share/opencode/storage/goal/"*.json 2>/dev/null | head -1 || true)"
  [ -z "$state" ] || cp "$state" "$WORK/permission-blocked-goal.json"
  echo "==> permission_blocked pending assertions (permission prompt reached: $blocked)"
  node "$HERE/assert-scenarios.mjs" \
    permission_blocked_pending \
    "$WORK/provider.log" \
    "${DB:-}" \
    "$WORK/permission-blocked-goal.json" \
    "$WORK/snaps"

  echo "==> Allow once"
  tmux -S "$SOCK" send-keys -t goal Enter
  for ((attempt = 0; attempt < WATCH; attempt++)); do
    state="$(ls "$WORK/home/.local/share/opencode/storage/goal/"*.json 2>/dev/null | head -1 || true)"
    if [ -n "$state" ] && node -e 'const fs=require("fs");const goal=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(goal.status==="complete"&&goal.review?.status==="accepted"?0:1)' "$state"; then
      break
    fi
    sleep 1
  done
  tmux -S "$SOCK" capture-pane -p -t goal >"$WORK/snaps/permission-approved.txt"
else
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
fi

if [ "$SCENARIO" = "soak" ]; then
  capture_goal_pane "$WORK/snaps/final.txt" || true
fi

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
  unclaimed | not_met_history | turns | interrupted | cache-stable | goal-events | permission_blocked | goal_check | silent | http500 | soak)
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

if [ "$SCENARIO" = "ux_goal_window" ]; then
  expanded="$WORK/snaps/ux-goal-expanded.txt"
  minimized="$WORK/snaps/ux-goal-minimized.txt"
  reexpanded="$WORK/snaps/ux-goal-reexpanded.txt"
  expanded_objective_rows="$(grep -Ec "$OBJECTIVE_ROW_PATTERN" "$expanded" || true)"
  minimized_objective_rows="$(grep -Ec "$OBJECTIVE_ROW_PATTERN" "$minimized" || true)"
  reexpanded_objective_rows="$(grep -Ec "$OBJECTIVE_ROW_PATTERN" "$reexpanded" || true)"
  distinctive_rows="$(grep -nE 'Amber|preserve|Zephyr' "$expanded" | cut -d: -f1 | sort -u | wc -l | tr -d ' ' || true)"
  goal_cap=$((PANE_ROWS / 4))
  if [ "$goal_cap" -lt 3 ]; then
    goal_cap=3
  fi

  if grep -Fq "◎ Goal active" "$expanded"; then
    ux_ok "goal window renders the active status line"
  else
    ux_fail "goal window renders the active status line"
  fi
  if grep -Fq "ctrl+x z minimize" "$expanded"; then
    ux_ok "expanded goal window renders the minimize hint"
  else
    ux_fail "expanded goal window renders the minimize hint"
  fi
  if [ "$distinctive_rows" -ge 3 ]; then
    ux_ok "distinctive objective words render on at least three pane rows"
  else
    ux_fail "distinctive objective words render on at least three pane rows" "$distinctive_rows rows"
  fi
  if [ "$expanded_objective_rows" -le "$goal_cap" ]; then
    ux_ok "expanded objective respects the $goal_cap-row height cap"
  else
    ux_fail "expanded objective respects the $goal_cap-row height cap" "$expanded_objective_rows rows"
  fi
  if grep -Fq "ctrl+x z expand" "$minimized"; then
    ux_ok "minimized goal window flips the hint to expand"
  else
    ux_fail "minimized goal window flips the hint to expand"
  fi
  # The truncation elides the MIDDLE of the status string, so the objective's
  # first or last words may legitimately survive on the status row. The
  # invariant is that exactly one row carries objective words and that row is
  # the status row itself — not which words survived the ellipsis.
  if [ "$minimized_objective_rows" -eq 1 ] &&
    grep -E "$OBJECTIVE_ROW_PATTERN" "$minimized" | grep -Fq "◎ Goal active"; then
    ux_ok "minimized objective occupies only the truncated status row"
  else
    ux_fail "minimized objective occupies only the truncated status row" "$minimized_objective_rows matching rows"
  fi
  if [ $((expanded_objective_rows + 1)) -gt "$minimized_objective_rows" ]; then
    ux_ok "minimizing shrinks the pane rows used by the goal widget"
  else
    ux_fail "minimizing shrinks the pane rows used by the goal widget"
  fi
  if grep -Fq "ctrl+x z minimize" "$reexpanded" &&
    grep -Fq "Zephyr" "$reexpanded" &&
    [ "$reexpanded_objective_rows" -eq "$expanded_objective_rows" ]; then
    ux_ok "expanding restores the full objective rows"
  else
    ux_fail "expanding restores the full objective rows" "$reexpanded_objective_rows rows after re-expand"
  fi
  goal_state="$(ls "$WORK/home/.local/share/opencode/storage/goal/"*.json 2>/dev/null | head -1 || true)"
  if [ -n "$goal_state" ] &&
    node -e 'const fs=require("fs");process.exit(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).status==="active"?0:1)' "$goal_state"; then
    ux_ok "durable goal remains active when the worker never claims completion"
  else
    ux_fail "durable goal remains active when the worker never claims completion"
  fi
  # The re-expanded snapshot is captured last, after the first worker reply
  # has certainly landed; the initial expanded capture can precede it.
  wrap_rows="$(grep -chE "intentionally a very long|word wrapping inside the|clipped single row" "$reexpanded" "$expanded" 2>/dev/null | paste -sd+ - | bc || true)"
  if [ "${wrap_rows:-0}" -ge 2 ]; then
    ux_ok "long assistant output wraps across multiple rows"
  else
    ux_fail "long assistant output wraps across multiple rows" "${wrap_rows:-0} matching rows"
  fi
fi

if [ "$SCENARIO" = "ux_queued_cancel" ]; then
  queued="$WORK/snaps/ux-queued-message.txt"
  actions="$WORK/snaps/ux-message-actions.txt"
  cancelled="$WORK/snaps/ux-message-cancelled.txt"

  if grep -Fq "$QUEUED_MESSAGE" "$queued"; then
    ux_ok "queued message text renders while review is busy"
  else
    ux_fail "queued message text renders while review is busy"
  fi
  if grep -Fq "QUEUED" "$queued"; then
    ux_ok "queued message renders the QUEUED badge"
  else
    ux_fail "queued message renders the QUEUED badge"
  fi
  if grep -Fq "Message Actions" "$actions"; then
    ux_ok "clicking the queued message opens Message Actions"
  else
    ux_fail "clicking the queued message opens Message Actions"
  fi
  if grep -Fq "Cancel queued message" "$actions"; then
    ux_ok "queued Message Actions puts cancellation first"
  else
    ux_fail "queued Message Actions puts cancellation first"
  fi
  if ! grep -Fq "Message Actions" "$cancelled"; then
    ux_ok "cancelling closes the Message Actions dialog"
  else
    ux_fail "cancelling closes the Message Actions dialog"
  fi
  # Cancellation restores the typed text into the composer, so the text is
  # STILL on screen by design — exactly once, with no QUEUED badge. Durable
  # deletion from the transcript is asserted separately against the database.
  if [ "$(grep -Fc "$QUEUED_MESSAGE" "$cancelled" || true)" -eq 1 ]; then
    ux_ok "cancelled text is restored into the composer exactly once"
  else
    ux_fail "cancelled text is restored into the composer exactly once" "$(grep -Fc "$QUEUED_MESSAGE" "$cancelled" || true) occurrences"
  fi
  if ! grep -Fq "QUEUED" "$cancelled"; then
    ux_ok "cancelled message leaves no QUEUED badge"
  else
    ux_fail "cancelled message leaves no QUEUED badge"
  fi

  DB="$(ls "$WORK/home/.local/share/opencode/"*.db 2>/dev/null | head -1 || true)"
  cancelled_rows=1
  if [ -n "$DB" ]; then
    cancelled_rows="$(sqlite3 "$DB" "SELECT count(*) FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id WHERE json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.text') LIKE '%cancel me before the review finishes%';" 2>/dev/null || echo 1)"
  fi
  if [ "$cancelled_rows" -eq 0 ]; then
    ux_ok "queued cancellation durably deletes the user message and part"
  else
    ux_fail "queued cancellation durably deletes the user message and part" "$cancelled_rows matching rows"
  fi
fi

if [ "$SCENARIO" = "ux_search" ]; then
  transcript="$WORK/snaps/ux-search-transcript.txt"
  opened="$WORK/snaps/ux-search-open.txt"
  counter="$WORK/snaps/ux-search-counter.txt"
  cycled="$WORK/snaps/ux-search-cycled.txt"
  slash="$WORK/snaps/ux-search-slash.txt"

  if grep -Fq "amber zebra" "$transcript" && grep -Fq "xylophone hummed" "$transcript"; then
    ux_ok "both searchable assistant replies render in the transcript"
  else
    ux_fail "both searchable assistant replies render in the transcript"
  fi
  if grep -Fq "Find in transcript" "$opened"; then
    ux_ok "leader+f opens the transcript search bar"
  else
    ux_fail "leader+f opens the transcript search bar"
  fi
  if grep -Fq "esc close" "$opened"; then
    ux_ok "search bar renders the cycling hint"
  else
    ux_fail "search bar renders the cycling hint"
  fi
  if grep -Fq "2/2" "$counter"; then
    ux_ok "typing a two-hit query lands on the most recent match with a 2/2 counter"
  else
    ux_fail "typing a two-hit query lands on the most recent match with a 2/2 counter"
  fi
  if grep -A2 -F "▍ match" "$counter" | grep -Fq "near the harbor"; then
    ux_ok "the most recent match has a visible gutter marker"
  else
    ux_fail "the most recent match has a visible gutter marker"
  fi
  if grep -Fq "1/2" "$cycled"; then
    ux_ok "enter cycles the counter to the older match"
  else
    ux_fail "enter cycles the counter to the older match"
  fi
  # The marker is its own one-line row ABOVE the matched text (a row-flex
  # sibling next to <markdown> clips wrapping — see TextPart).
  if grep -A2 -F "▍ match" "$WORK/snaps/ux-search-cycled-marker.txt" | grep -Fq "amber zebra"; then
    ux_ok "cycling moves the visible gutter marker to the older match"
  else
    ux_fail "cycling moves the visible gutter marker to the older match"
  fi
  if [ "${UX_SEARCH_CLOSED:-0}" -eq 1 ]; then
    ux_ok "escape closes the search bar"
  else
    ux_fail "escape closes the search bar"
  fi
  if grep -Fq "esc close" "$slash"; then
    ux_ok "/find reopens the transcript search bar"
  else
    ux_fail "/find reopens the transcript search bar"
  fi
  # The hints row is covered by goal pacing status once a goal runs, so the
  # find hint is asserted on the idle pre-goal startup capture.
  if grep -Fq "f find" "$WORK/snaps/00-startup.txt"; then
    ux_ok "the session footer advertises the find shortcut"
  else
    ux_fail "the session footer advertises the find shortcut"
  fi
fi

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

if [ "$failures" -gt 0 ]; then
  exit 1
fi
