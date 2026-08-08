#!/usr/bin/env bash
# Drive a compiled OpenCode binary through background-subagent scenarios against
# an isolated fake OpenAI-compatible provider, inside a dedicated tmux socket.
#
# Nothing here touches the real HOME, provider credentials, or session storage:
# HOME/XDG are redirected into a scratch tree recreated on every run.
#
#   ./script/subagent-harness/drive.sh <scenario> [seconds]
#
# Scenarios:
#   notify  child completes while parent is idle; notification re-invokes parent
#   steer   a second parent prompt redirects its own child whose first request is hung;
#           rightful-owner control for ownership, so both scenarios must be run together
#   inspect task_output observes a running child, then task_stop stops it
#   fanout  three background children use distinct per-call models and variants;
#           all three completion notifications must reach the parent
#   stop-one two children remain busy; the running-tasks dialog's two-press
#           ctrl+d action stops only the selected row and renders its stopped state
#   ownership parent A owns A1; a fresh parent B is refused when it calls task(task_id=A1);
#           foreign-owner half of steer, so both scenarios must be run together
#
# Useful overrides:
#   BIN=...     path to the compiled binary
#   PROMPT=...  first parent prompt (must retain the default classification marker)
#   PORT=...    fake-provider port
#   WORK=...    scratch tree removed and recreated on every run
#   SOCK=...    dedicated tmux socket
set -euo pipefail

SCENARIO="${1:-notify}"
WATCH="${2:-35}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

BIN="${BIN:-$ROOT/packages/opencode/dist/opencode-darwin-arm64/bin/opencode}"
PROMPT="${PROMPT:-Spawn a background investigation and then wait.}"
PORT="${PORT:-4599}"
WORK="${WORK:-${TMPDIR:-/tmp}/opencode-subagent-harness}"
SOCK="${SOCK:-/tmp/opencode-subagent-harness.sock}"

case "$SCENARIO" in
  notify | steer | inspect | fanout | stop-one | ownership) ;;
  *)
    echo "usage: $0 <notify|steer|inspect|fanout|stop-one|ownership> [seconds]" >&2
    exit 2
    ;;
esac

case "$WORK" in
  "" | / | /tmp | "${TMPDIR:-/tmp}" | "$HOME" | "$ROOT" | "$HERE")
    echo "refusing unsafe WORK directory: $WORK" >&2
    exit 2
    ;;
esac
if [[ "$PROMPT" != *"Spawn a background investigation and then wait."* ]]; then
  echo "PROMPT must contain the parent classification marker: Spawn a background investigation and then wait." >&2
  exit 2
fi
if [ ! -x "$BIN" ]; then
  echo "no binary at $BIN" >&2
  echo "build one with: OPENCODE_VERSION=dev ./packages/opencode/script/build.ts --single --skip-install --skip-embed-web-ui" >&2
  exit 1
fi
command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

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
if [ "$SCENARIO" = "fanout" ] || [ "$SCENARIO" = "stop-one" ]; then
  # Keep the checked-in config single-model. These scenarios expand only the
  # isolated scratch copy so each task(model=..., variant=...) resolves through
  # the same fake provider without touching opencode.json.
  node -e '
    const fs=require("fs")
    const file=process.argv[1]
    const config=JSON.parse(fs.readFileSync(file,"utf8"))
    const base=config.provider.fake.models["fake-model"]
    for (const [name,variant] of [["one","low"],["two","medium"],["three","high"]]) {
      config.provider.fake.models[`fake-model-${name}`]={...base,id:`fake-model-${name}`,name:`Fake Model ${name}`,variants:{[variant]:{}}}
    }
    fs.writeFileSync(file,JSON.stringify(config,null,2))
  ' "$WORK/proj/opencode.json"
fi

echo "==> fake provider (:$PORT, SCENARIO=$SCENARIO)"
PORT="$PORT" LOG="$WORK/provider.log" SCENARIO="$SCENARIO" \
  node "$HERE/fake-provider.mjs" >"$WORK/provider.out" 2>&1 &
echo $! >"$WORK/provider.pid"
sleep 1
cat "$WORK/provider.out"

echo "==> $("$BIN" --version) in tmux ($SOCK)"
tmux -S "$SOCK" kill-server 2>/dev/null || true
tmux -S "$SOCK" new-session -d -x 160 -y 45 -s subagent -c "$WORK/proj" \
  "HOME=$WORK/home \
   XDG_DATA_HOME=$WORK/home/.local/share \
   XDG_CONFIG_HOME=$WORK/home/.config \
   XDG_CACHE_HOME=$WORK/home/.cache \
   OPENCODE_DISABLE_AUTOUPDATE=1 \
   '$BIN' --pure 2>&1 | tee $WORK/tui.log"

send_prompt() {
  echo "==> $1"
  tmux -S "$SOCK" send-keys -l -t subagent -- "$1"
  sleep 1
  tmux -S "$SOCK" send-keys -t subagent Enter
}

wait_for_children() {
  local expected="$1"
  for ((attempt = 0; attempt < 40; attempt++)); do
    if curl --silent --show-error "http://127.0.0.1:$PORT/__harness/state" \
      | node -e 'let data="";process.stdin.on("data",(chunk)=>data+=chunk).on("end",()=>process.exit(JSON.parse(data).activeChildModels.length===Number(process.argv[1])?0:1))' "$expected"; then
      return
    fi
    sleep 0.25
  done
  echo "FAIL expected $expected live child provider request(s) before driving the dialog" >&2
  return 1
}

sleep 15
tmux -S "$SOCK" capture-pane -p -t subagent >"$WORK/snaps/00-startup.txt"
send_prompt "$PROMPT"

elapsed=0
while [ "$elapsed" -lt "$WATCH" ]; do
  sleep 1
  elapsed=$((elapsed + 1))

  if [ "$SCENARIO" = "steer" ] && [ "$elapsed" -eq 8 ]; then
    send_prompt "Course-correct that task."
  fi
  if [ "$SCENARIO" = "inspect" ] && [ "$elapsed" -eq 8 ]; then
    send_prompt "Check on it."
  fi
  if [ "$SCENARIO" = "inspect" ] && [ "$elapsed" -eq 13 ]; then
    send_prompt "Stop it."
  fi
  if [ "$SCENARIO" = "stop-one" ] && [ "$elapsed" -eq 8 ]; then
    wait_for_children 2
    echo "==> open Running tasks and stop the selected row with two ctrl+d presses"
    tmux -S "$SOCK" send-keys -t subagent C-p
    sleep 1
    tmux -S "$SOCK" send-keys -l -t subagent -- "running"
    sleep 1
    tmux -S "$SOCK" send-keys -t subagent Enter
    sleep 1
    tmux -S "$SOCK" capture-pane -p -t subagent >"$WORK/snaps/stop-dialog.txt"
    tmux -S "$SOCK" send-keys -t subagent C-d
    sleep 1
    tmux -S "$SOCK" capture-pane -p -t subagent >"$WORK/snaps/stop-confirm.txt"
    tmux -S "$SOCK" send-keys -t subagent C-d
    sleep 2
    tmux -S "$SOCK" capture-pane -p -t subagent >"$WORK/snaps/stop-result.txt"
  fi
  if [ "$SCENARIO" = "ownership" ] && [ "$elapsed" -eq 8 ]; then
    wait_for_children 1
    echo "==> create parent B from the command palette"
    tmux -S "$SOCK" send-keys -t subagent C-p
    sleep 1
    tmux -S "$SOCK" send-keys -l -t subagent -- "new session"
    sleep 1
    tmux -S "$SOCK" send-keys -t subagent Enter
    sleep 2
    send_prompt "SECOND_PARENT_OWNERSHIP_PROBE: attempt to resume parent A's child."
  fi

  if [ $((elapsed % 5)) -ne 0 ]; then
    continue
  fi
  tmux -S "$SOCK" capture-pane -p -t subagent >"$WORK/snaps/$(printf '%03d' "$elapsed").txt"
  echo "--- +${elapsed}s"
  tmux -S "$SOCK" capture-pane -p -t subagent \
    | grep -E "background|subagent|task|acknowledged|stopped|correction|Running tasks|Press ctrl.d again|ownership" \
    | head -8 || true
done

DB="$WORK/home/.local/share/opencode/opencode.db"
echo
echo "==> durable state"
if [ ! -f "$DB" ]; then
  echo "database missing: $DB"
  echo "FAIL database was created"
  echo "==> snapshots: $WORK/snaps"
  echo "==> provider request log: $WORK/provider.log"
  exit 1
fi
sqlite3 -header -column "$DB" <<'SQL'
.tables
SELECT id, parent_id, title FROM session ORDER BY time_created, id;
SELECT
  p.session_id,
  json_extract(m.data, '$.role') AS role,
  json_extract(p.data, '$.type') AS type,
  json_extract(p.data, '$.tool') AS tool,
  substr(coalesce(json_extract(p.data, '$.text'), json_extract(p.data, '$.state.output'), json_extract(p.data, '$.state.status')), 1, 180) AS content
FROM part p
JOIN message m ON m.id = p.message_id
ORDER BY p.time_created, p.id;
SQL

failures=0
pass() {
  echo "PASS $1"
}
fail() {
  echo "FAIL $1"
  failures=$((failures + 1))
}

if [ "$SCENARIO" = "notify" ]; then
  notify_reinvoked="$(sqlite3 "$DB" <<'SQL'
SELECT count(*)
FROM part notification
JOIN message notified ON notified.id = notification.message_id
JOIN session parent ON parent.id = notified.session_id
WHERE parent.parent_id IS NULL
  AND json_extract(notified.data, '$.role') = 'user'
  AND json_extract(notification.data, '$.text') LIKE '%<task-notification task_id=%status="completed"%'
  AND EXISTS (
    SELECT 1
    FROM message assistant
    WHERE assistant.session_id = notified.session_id
      AND json_extract(assistant.data, '$.role') = 'assistant'
      AND assistant.id > notified.id
  );
SQL
)"
  if [ "$notify_reinvoked" -gt 0 ]; then
    pass "notify parent assistant message follows completed task-notification without a keypress"
  else
    fail "notify parent assistant message follows completed task-notification without a keypress"
  fi
fi

if [ "$SCENARIO" = "steer" ]; then
  # OWNERSHIP INVARIANT PAIR: this scenario proves the rightful parent can
  # resume via task_id. Run both `steer` and `ownership`; neither is complete alone.
  steer_persisted="$(sqlite3 "$DB" <<'SQL'
SELECT count(*)
FROM session child
JOIN message m ON m.session_id = child.id
JOIN part p ON p.message_id = m.id
WHERE child.parent_id IS NOT NULL
  AND json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.text') LIKE '%change of plan: only inspect the cache layer%';
SQL
)"
  steer_ack="$(sqlite3 "$DB" <<'SQL'
SELECT count(*)
FROM session child
JOIN message m ON m.session_id = child.id
JOIN part p ON p.message_id = m.id
WHERE child.parent_id IS NOT NULL
  AND json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(p.data, '$.text') LIKE '%acknowledged mid-run correction%';
SQL
)"
  steer_live="$(grep -c '"role":"steer-issued","scenario":"steer","whileFirstOpen":true' "$WORK/provider.log" || true)"
  if [ "$steer_persisted" -gt 0 ] && [ "$steer_live" -gt 0 ]; then
    pass "steer rightful parent resumed its child via task_id while the first provider request was open"
  else
    fail "steer rightful parent resumed its child via task_id while the first provider request was open"
  fi
  if [ "$steer_ack" -gt 0 ]; then
    pass "steer child produced acknowledged mid-run correction"
  else
    fail "steer child produced acknowledged mid-run correction"
  fi
fi

if [ "$SCENARIO" = "ownership" ]; then
  # OWNERSHIP INVARIANT PAIR: this scenario proves the newest, foreign parent
  # is refused. Run both `steer` and `ownership`; neither is complete alone.
  newest_root_refusals="$(sqlite3 "$DB" <<'SQL'
SELECT count(*)
FROM part p
WHERE p.session_id = (
    SELECT id
    FROM session
    WHERE parent_id IS NULL
    ORDER BY time_created DESC, id DESC
    LIMIT 1
  )
  AND json_extract(p.data, '$.tool') = 'task'
  AND coalesce(json_extract(p.data, '$.state.error'), json_extract(p.data, '$.state.output')) LIKE '%not owned by session%';
SQL
)"
  if [ "$newest_root_refusals" -eq 1 ]; then
    pass "ownership newest root parent B recorded the task_id ownership refusal"
  else
    fail "ownership newest root parent B recorded the task_id ownership refusal"
  fi
fi

if [ "$SCENARIO" = "inspect" ]; then
  inspect_running="$(sqlite3 "$DB" <<'SQL'
SELECT count(*)
FROM session parent
JOIN part p ON p.session_id = parent.id
WHERE parent.parent_id IS NULL
  AND json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.tool') = 'task_output'
  AND json_extract(p.data, '$.state.status') = 'completed'
  AND json_extract(p.data, '$.state.output') LIKE '%<task-output task_id=%status="running"%';
SQL
)"
  inspect_stopped="$(sqlite3 "$DB" <<'SQL'
SELECT count(*)
FROM session parent
JOIN message m ON m.session_id = parent.id
JOIN part p ON p.message_id = m.id
WHERE parent.parent_id IS NULL
  AND json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.text') LIKE '%<task-notification task_id=%status="stopped"%';
SQL
)"
  if [ "$inspect_running" -gt 0 ]; then
    pass "inspect parent task_output tool part recorded running status"
  else
    fail "inspect parent task_output tool part recorded running status"
  fi
  if [ "$inspect_stopped" -gt 0 ]; then
    pass "inspect parent received stopped task-notification"
  else
    fail "inspect parent received stopped task-notification"
  fi
fi

if [ "$SCENARIO" = "stop-one" ]; then
  curl --silent --show-error "http://127.0.0.1:$PORT/__harness/state" >"$WORK/provider-state.json"
  echo "==> provider live state"
  cat "$WORK/provider-state.json"
fi

case "$SCENARIO" in
  fanout | stop-one | ownership)
    echo "==> $SCENARIO assertions"
    node "$HERE/assert-scenarios.mjs" \
      "$SCENARIO" \
      "$WORK/provider.log" \
      "$DB" \
      "$WORK/snaps" \
      "$WORK/provider-state.json"
    ;;
esac

echo "==> snapshots: $WORK/snaps"
echo "==> provider request log: $WORK/provider.log"
if [ "$failures" -gt 0 ]; then
  exit 1
fi
