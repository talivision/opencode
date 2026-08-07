#!/usr/bin/env bash
# Drive a compiled OpenCode binary through permission and compaction scenarios
# against an isolated fake OpenAI-compatible provider in a dedicated tmux
# socket. HOME/XDG and the project are recreated in a scratch tree every run.
#
#   ./script/permission-harness/drive.sh <scenario> [seconds]
#
# Scenarios:
#   auto-suppresses  normal mode blocks; shift+tab auto mode completes bash
#   auto-inherits    a general subagent inherits parent auto mode
#   deny-wins        auto allows benign bash but preserves an explicit deny
#   grant-persists   "Allow always" survives killing and restarting the TUI
#   compaction       dynamic max_tokens shrinks, compacts once, then continues
#
# Useful overrides:
#   BIN=...   path to the compiled binary
#   PORT=...  fake-provider port
#   WORK=...  scratch tree removed and recreated on every run
#   SOCK=...  dedicated tmux socket
set -euo pipefail

SCENARIO="${1:-auto-suppresses}"
WATCH="${2:-45}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

BIN="${BIN:-$ROOT/packages/opencode/dist/opencode-darwin-arm64/bin/opencode}"
PORT="${PORT:-4599}"
WORK="${WORK:-${TMPDIR:-/tmp}/opencode-permission-harness}"
SOCK="${SOCK:-/tmp/opencode-permission-harness.sock}"
SESSION=permission

case "$SCENARIO" in
  auto-suppresses | auto-inherits | deny-wins | grant-persists | compaction) ;;
  *)
    echo "usage: $0 <auto-suppresses|auto-inherits|deny-wins|grant-persists|compaction> [seconds]" >&2
    exit 2
    ;;
esac

case "$WORK" in
  "" | / | /tmp | "${TMPDIR:-/tmp}" | "$HOME" | "$ROOT" | "$HERE")
    echo "refusing unsafe WORK directory: $WORK" >&2
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
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

cleanup() {
  tmux -S "$SOCK" kill-server 2>/dev/null || true
  [ -f "$WORK/provider.pid" ] && kill "$(cat "$WORK/provider.pid")" 2>/dev/null || true
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$WORK/home" "$WORK/proj" "$WORK/snaps"
cp "$HERE/opencode.json" "$WORK/proj/opencode.json"
git init -q "$WORK/proj"
# A commit is required, not optional. Project.resolve derives the project id
# from remote -> cached -> ROOT COMMIT, falling back to the shared "global" id,
# and global-project state is deliberately not persisted (an approval made in
# one non-VCS directory must not apply in another). A freshly init'd repo with
# no commits therefore behaves exactly like a non-git directory: grants do not
# persist and auto-approvals are not audited. Without this commit the
# persistence and audit assertions below test nothing.
git -C "$WORK/proj" -c user.email=h@example.com -c user.name=harness commit -q --allow-empty -m "harness base"
node -e '
const fs = require("fs")
const file = process.argv[1]
const port = process.argv[2]
const scenario = process.argv[3]
const config = JSON.parse(fs.readFileSync(file, "utf8"))
config.provider.fake.options.baseURL = `http://127.0.0.1:${port}/v1`
if (scenario === "deny-wins") config.permission = { bash: { "*": "ask", "rm -rf *": "deny" } }
if (scenario === "compaction") config.permission = { "*": "deny" }
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
' "$WORK/proj/opencode.json" "$PORT" "$SCENARIO"

echo "==> fake provider (:$PORT, SCENARIO=$SCENARIO)"
PORT="$PORT" LOG="$WORK/provider.log" SCENARIO="$SCENARIO" \
  node "$HERE/fake-provider.mjs" >"$WORK/provider.out" 2>&1 &
echo $! >"$WORK/provider.pid"
sleep 1
cat "$WORK/provider.out"

start_tui() {
  local output="$1"
  tmux -S "$SOCK" new-session -d -x 160 -y 45 -s "$SESSION" -c "$WORK/proj" \
    "HOME='$WORK/home' \
     XDG_DATA_HOME='$WORK/home/.local/share' \
     XDG_CONFIG_HOME='$WORK/home/.config' \
     XDG_CACHE_HOME='$WORK/home/.cache' \
     OPENCODE_DISABLE_AUTOUPDATE=1 \
     '$BIN' --pure 2>&1 | tee '$output'"
}

capture() {
  tmux -S "$SOCK" capture-pane -p -t "$SESSION" >"$WORK/snaps/$1.txt"
}

send_prompt() {
  echo "==> $1"
  tmux -S "$SOCK" send-keys -l -t "$SESSION" -- "$1"
  sleep 1
  tmux -S "$SOCK" send-keys -t "$SESSION" Enter
}

wait_pane() {
  local pattern="$1"
  local label="$2"
  local elapsed=0
  while [ "$elapsed" -lt "$WATCH" ]; do
    capture "$label-current"
    if grep -Fq "$pattern" "$WORK/snaps/$label-current.txt"; then
      capture "$label"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  capture "$label-timeout"
  return 1
}

wait_log() {
  local pattern="$1"
  local elapsed=0
  while [ "$elapsed" -lt "$WATCH" ]; do
    if [ -f "$WORK/provider.log" ] && grep -Fq "$pattern" "$WORK/provider.log"; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

DB="$WORK/home/.local/share/opencode/opencode.db"
tool_count() {
  local command="$1"
  local status="$2"
  if [ ! -f "$DB" ]; then
    echo 0
    return
  fi
  sqlite3 "$DB" "
SELECT count(*)
FROM part
WHERE json_extract(data, '$.type') = 'tool'
  AND json_extract(data, '$.tool') = 'bash'
  AND json_extract(data, '$.state.input.command') = '$command'
  AND json_extract(data, '$.state.status') = '$status';
" 2>/dev/null || echo 0
}

wait_tool() {
  local command="$1"
  local status="$2"
  local elapsed=0
  while [ "$elapsed" -lt "$WATCH" ]; do
    if [ "$(tool_count "$command" "$status")" -gt 0 ]; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

failures=0
pass() {
  echo "PASS $1"
}
fail() {
  echo "FAIL $1"
  failures=$((failures + 1))
}

echo "==> $("$BIN" --version) in tmux ($SOCK)"
tmux -S "$SOCK" kill-server 2>/dev/null || true
start_tui "$WORK/tui.log"
sleep 15
capture 00-startup

if [ "$SCENARIO" = "auto-suppresses" ]; then
  send_prompt "PERMISSION_HARNESS_AUTO_SUPPRESSES_CONTROL"
  if wait_pane "Permission required" 10-control-prompt; then
    pass "auto-suppresses control displayed a permission prompt with auto off"
  else
    fail "auto-suppresses control displayed a permission prompt with auto off"
  fi
  if [ "$(tool_count "printf auto-control" completed)" -eq 0 ]; then
    pass "auto-suppresses control bash did not complete while permission was pending"
  else
    fail "auto-suppresses control bash did not complete while permission was pending"
  fi

  echo "==> shift+tab: enable server-side auto mode"
  tmux -S "$SOCK" send-keys -t "$SESSION" BTab
  if wait_tool "printf auto-control" completed; then
    pass "auto-suppresses enabling auto released the pending bash call"
  else
    fail "auto-suppresses enabling auto released the pending bash call"
  fi
  capture 20-auto-enabled
  send_prompt "PERMISSION_HARNESS_AUTO_SUPPRESSES_ACTIVE"
  if wait_tool "printf auto-active" completed; then
    pass "auto-suppresses bash completed under auto mode"
  else
    fail "auto-suppresses bash completed under auto mode"
  fi
  capture 21-auto-complete
  if grep -Fq "Permission required" "$WORK/snaps/20-auto-enabled.txt" "$WORK/snaps/21-auto-complete.txt"; then
    fail "auto-suppresses showed no permission prompt after auto was enabled"
  else
    pass "auto-suppresses showed no permission prompt after auto was enabled"
  fi
fi

if [ "$SCENARIO" = "auto-inherits" ]; then
  send_prompt "PERMISSION_HARNESS_AUTO_INHERITS_PREFLIGHT"
  wait_pane "preflight complete" 10-preflight || true
  echo "==> shift+tab: enable parent auto mode"
  tmux -S "$SOCK" send-keys -t "$SESSION" BTab
  wait_pane "auto-approve on" 11-auto-enabled || true
  send_prompt "PERMISSION_HARNESS_AUTO_INHERITS_PARENT"
  capture 20-inherits-started
  wait_tool "printf inherited-child" completed || true
  capture 21-inherits-complete

  child_completed="$(sqlite3 "$DB" 2>/dev/null <<'SQL' || true
SELECT count(*)
FROM part p
JOIN session child ON child.id = p.session_id
WHERE child.parent_id IS NOT NULL
  AND json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.tool') = 'bash'
  AND json_extract(p.data, '$.state.input.command') = 'printf inherited-child'
  AND json_extract(p.data, '$.state.status') = 'completed';
SQL
)"
  child_completed="${child_completed:-0}"
  if [ "$child_completed" -gt 0 ]; then
    pass "auto-inherits child bash tool completed"
  else
    fail "auto-inherits child bash tool completed"
  fi
  if grep -aFq "Permission required" "$WORK/tui.log" "$WORK/snaps/20-inherits-started.txt" "$WORK/snaps/21-inherits-complete.txt"; then
    fail "auto-inherits no parent or child permission prompt appeared"
  else
    pass "auto-inherits no parent or child permission prompt appeared"
  fi
  child_id="$(sqlite3 "$DB" "SELECT id FROM session WHERE parent_id IS NOT NULL ORDER BY time_created LIMIT 1;" 2>/dev/null || true)"
  if node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]
const child = process.argv[2]
const files = fs.existsSync(root) ? fs.readdirSync(root).map((name) => path.join(root, name)) : []
const entries = files.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).audit ?? [])
process.exit(entries.some((item) => item.sessionID === child && item.permission === "bash" && item.pattern === "printf inherited-child") ? 0 : 1)
' "$WORK/home/.local/share/opencode/storage/permission" "$child_id"; then
    pass "auto-inherits child bash was server-auto-approved and audited without a request"
  else
    fail "auto-inherits child bash was server-auto-approved and audited without a request"
  fi
fi

if [ "$SCENARIO" = "deny-wins" ]; then
  send_prompt "PERMISSION_HARNESS_DENY_WINS_PREFLIGHT"
  wait_pane "preflight complete" 10-preflight || true
  echo "==> shift+tab: enable auto mode"
  tmux -S "$SOCK" send-keys -t "$SESSION" BTab
  wait_pane "auto-approve on" 11-auto-enabled || true
  send_prompt "PERMISSION_HARNESS_DENY_WINS"
  if wait_tool "printf benign-auto-allowed" completed; then
    pass "deny-wins benign bash completed under auto mode"
  else
    fail "deny-wins benign bash completed under auto mode"
  fi
  if wait_tool "rm -rf /tmp/x" error; then
    pass "deny-wins explicit rm deny produced an error instead of executing"
  else
    fail "deny-wins explicit rm deny produced an error instead of executing"
  fi
  capture 20-deny-complete
  if grep -aFq "Permission required" "$WORK/tui.log" "$WORK/snaps/20-deny-complete.txt"; then
    fail "deny-wins completed without an ask prompt"
  else
    pass "deny-wins completed without an ask prompt"
  fi
fi

if [ "$SCENARIO" = "grant-persists" ]; then
  send_prompt "PERMISSION_HARNESS_GRANT_PERSISTS_FIRST"
  if wait_pane "Allow always" 10-grant-prompt; then
    pass "grant-persists captured the permission UI and found Allow always"
  else
    fail "grant-persists captured the permission UI and found Allow always"
  fi
  echo "==> Right + Enter selects Allow always; Enter confirms"
  tmux -S "$SOCK" send-keys -t "$SESSION" Right Enter
  sleep 1
  capture 11-grant-confirm
  if grep -Fq "Always allow" "$WORK/snaps/11-grant-confirm.txt"; then
    pass "grant-persists reached the Always allow confirmation screen"
  else
    fail "grant-persists reached the Always allow confirmation screen"
  fi
  tmux -S "$SOCK" send-keys -t "$SESSION" Enter
  if wait_tool "printf grant-persisted" completed; then
    pass "grant-persists first bash completed after always approval"
  else
    fail "grant-persists first bash completed after always approval"
  fi

  echo "==> kill and relaunch TUI against the same HOME and project"
  tmux -S "$SOCK" kill-session -t "$SESSION"
  sleep 2
  start_tui "$WORK/tui-restart.log"
  sleep 15
  capture 20-restarted
  send_prompt "PERMISSION_HARNESS_GRANT_PERSISTS_SECOND"
  elapsed=0
  while [ "$elapsed" -lt "$WATCH" ]; do
    capture "21-restart-$(printf '%03d' "$elapsed")"
    if [ "$(tool_count "printf grant-persisted" completed)" -ge 2 ]; then
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  capture 22-restart-complete
  if [ "$(tool_count "printf grant-persisted" completed)" -ge 2 ]; then
    pass "grant-persists identical bash completed after process restart"
  else
    fail "grant-persists identical bash completed after process restart"
  fi
  if grep -aFq "Permission required" "$WORK/tui-restart.log" "$WORK/snaps"/21-restart-*.txt "$WORK/snaps/22-restart-complete.txt"; then
    fail "grant-persists second identical bash showed no permission prompt"
  else
    pass "grant-persists second identical bash showed no permission prompt"
  fi
  if node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]
const files = fs.existsSync(root) ? fs.readdirSync(root).map((name) => path.join(root, name)) : []
const grants = files.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).grants ?? [])
process.exit(grants.some((item) => item.permission === "bash" && item.pattern === "printf grant-persisted") ? 0 : 1)
' "$WORK/home/.local/share/opencode/storage/permission"; then
    pass "grant-persists concrete bash grant exists in the project-scoped store"
  else
    fail "grant-persists concrete bash grant exists in the project-scoped store"
  fi
fi

if [ "$SCENARIO" = "compaction" ]; then
  for turn in 1 2 3 4 5 6 7 8; do
    send_prompt "PERMISSION_HARNESS_COMPACTION_TURN_$turn"
    if ! wait_log "\"phase\":\"compaction-turn-$turn\""; then
      fail "compaction provider received turn $turn"
      break
    fi
    if [ "$turn" -eq 6 ]; then
      wait_log '"classification":"summary"' || true
      wait_log '"phase":"continuation"' || true
    fi
    sleep 2
    capture "$(printf '10-turn-%02d' "$turn")"
  done

  if node -e '
const fs = require("fs")
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
const summaryAt = lines.findIndex((item) => item.classification === "summary")
const turns = lines.filter((item, index) => index < summaryAt && item.scenario === "compaction" && /^compaction-turn-/.test(item.phase ?? ""))
const values = turns.map((item) => item.max_tokens)
if (values.length < 3 || values.some((item) => !Number.isInteger(item))) process.exit(1)
if (!values.some((item, index) => index > 0 && item < values[index - 1])) process.exit(1)
console.log(`max_tokens before compaction: ${values.join(" -> ")}`)
' "$WORK/provider.log"; then
    pass "compaction requested max_tokens shrank as measured context grew"
  else
    fail "compaction requested max_tokens shrank as measured context grew"
  fi
  if node -e '
const fs = require("fs")
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
const summaryAt = lines.findIndex((item) => item.classification === "summary")
const values = lines
  .filter((item, index) => index < summaryAt && item.scenario === "compaction" && /^compaction-turn-/.test(item.phase ?? ""))
  .map((item) => item.reported_prompt_tokens)
process.exit(values.length >= 3 && values.every((item, index) => index === 0 || item > values[index - 1]) ? 0 : 1)
' "$WORK/provider.log"; then
    pass "compaction provider reported strictly growing prompt_tokens before compaction"
  else
    fail "compaction provider reported strictly growing prompt_tokens before compaction"
  fi
  if node -e '
const fs = require("fs")
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
const values = lines.filter((item) => item.scenario === "compaction" && Number.isInteger(item.max_tokens)).map((item) => item.max_tokens)
process.exit(values.length > 0 && values.every((item) => item >= 1000) ? 0 : 1)
' "$WORK/provider.log"; then
    pass "compaction max_tokens never dropped below configured output_floor=1000"
  else
    fail "compaction max_tokens never dropped below configured output_floor=1000"
  fi
  summary_count="$(grep -c '"classification":"summary"' "$WORK/provider.log" || true)"
  if [ "$summary_count" -eq 1 ]; then
    pass "compaction exactly one request matched the exact summary system prompt"
  else
    fail "compaction exactly one request matched the exact summary system prompt"
  fi
  if node -e '
const fs = require("fs")
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
const control = lines.find((item) => item.phase === "compaction-turn-1")
process.exit(control?.classification === "worker" && control.summarySystemMatches === 0 ? 0 : 1)
' "$WORK/provider.log"; then
    pass "compaction control turn had zero exact summary-system matches"
  else
    fail "compaction control turn had zero exact summary-system matches"
  fi
  if node -e '
const fs = require("fs")
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
const summaryAt = lines.findIndex((item) => item.classification === "summary")
const later = lines.findIndex((item) => item.phase === "compaction-turn-8")
process.exit(summaryAt >= 0 && later > summaryAt ? 0 : 1)
' "$WORK/provider.log" && grep -q 'compaction turn 8 completed' <(
    sqlite3 "$DB" "SELECT json_extract(data, '$.text') FROM part WHERE json_extract(data, '$.type') = 'text';"
  ); then
    pass "compaction session completed a later turn after the summary call"
  else
    fail "compaction session completed a later turn after the summary call"
  fi
  if node -e '
const fs = require("fs")
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const limit = config.provider.fake.models["fake-model"].limit
process.exit(limit.context === 12000 && limit.output === 4000 && !("input" in limit) ? 0 : 1)
' "$WORK/proj/opencode.json"; then
    pass "compaction model uses context=12000, output=4000, and no limit.input"
  else
    fail "compaction model uses context=12000, output=4000, and no limit.input"
  fi
fi

echo
echo "==> durable state"
if [ -f "$DB" ]; then
  sqlite3 -header -column "$DB" <<'SQL'
SELECT id, parent_id, title FROM session ORDER BY time_created, id;
SELECT
  p.session_id,
  json_extract(p.data, '$.tool') AS tool,
  json_extract(p.data, '$.state.input.command') AS command,
  json_extract(p.data, '$.state.status') AS status
FROM part p
WHERE json_extract(p.data, '$.type') = 'tool'
ORDER BY p.time_created, p.id;
SQL
else
  fail "database was created"
fi
echo "==> snapshots: $WORK/snaps"
echo "==> provider request log: $WORK/provider.log"
if [ "$failures" -gt 0 ]; then
  exit 1
fi
