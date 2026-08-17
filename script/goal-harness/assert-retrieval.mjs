// Assertions for REVIEWER_MODE=retrieval, run by drive.sh after the tmux run.
//
// Two independent sources of truth:
//   * the provider request log (full request bodies, one JSON line per request)
//   * the session sqlite db (snake_case columns: session_id, parent_id)
//
//   node assert-retrieval.mjs <provider.log> <opencode.db> [goal-state-dir]
import fs from "node:fs"
import path from "node:path"

// node:sqlite is only present on newer Node; the log-based assertions are the
// load-bearing ones, so a missing module skips rather than fails the run.
let DatabaseSync
try {
  ;({ DatabaseSync } = await import("node:sqlite"))
} catch {
  DatabaseSync = undefined
}

const [logPath, dbPath, goalDir] = process.argv.slice(2)
const failures = []
const notes = []

function check(name, ok, detail) {
  if (ok) notes.push(`ok   ${name}`)
  else failures.push(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}

if (!fs.existsSync(logPath)) {
  console.error(`no provider log at ${logPath}`)
  process.exit(1)
}

const entries = fs
  .readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const reviewer = entries.filter((entry) => entry.role === "reviewer")
const bodies = reviewer.map((entry) => JSON.stringify(entry.body))

check("reviewer requests were made", reviewer.length > 0, `${reviewer.length} reviewer requests`)

const seeds = bodies.filter((body) => body.includes("<parent-session-index>"))
check("the reviewer seed carries the session index", seeds.length > 0)
check(
  "every retrieval review follows an explicit worker completion claim",
  seeds.length > 0 && seeds.every((body) => body.includes(" goal [completed]")),
)
check(
  "the reviewer seed no longer inlines the parent transcript",
  !bodies.some((body) => body.includes("<parent-session-transcript>")),
)

const first = seeds[0] ?? ""
check("attempt 1 is told no checklist exists", first.includes("No requirement checklist has been recorded"))

const inherited = seeds.filter((body) => body.includes("Earlier reviewers recorded this checklist"))
check("attempt 2 inherits the persisted checklist", inherited.length > 0)
check(
  "attempt 2 inherits per-requirement conclusions",
  inherited.some((body) => body.includes("R2 [unmet, attempt 1]")),
)

// The index names tool calls but never their output. The goal tool's own
// output string is the cheapest raw-output canary available in this scenario.
const RAW_OUTPUT_MARKERS = ["Completion is pending independent review", "Checklist recorded. Verify each requirement"]
for (const marker of RAW_OUTPUT_MARKERS) {
  check(
    `attempt 2's seed omits raw worker tool output: ${JSON.stringify(marker.slice(0, 32))}`,
    !inherited.some((body) =>
      body.split("<parent-session-index>")[1]?.split("</parent-session-index>")[0]?.includes(marker),
    ),
  )
}

check(
  "the reviewer retrieved through goal_transcript",
  bodies.some((body) => body.includes("untrusted-parent-transcript")),
)

if (DatabaseSync && dbPath && fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare("SELECT id, parent_id, title FROM session WHERE parent_id IS NOT NULL").all()
  const reviews = rows.filter((row) => String(row.title ?? "").startsWith("Goal review"))
  // A fresh reviewer session per attempt: reusing one would re-send its own
  // stale retrieval output on every later step.
  check("each review attempt got its own child session", reviews.length >= 2, `${reviews.length} reviewer sessions`)
  check(
    "every reviewer session hangs off the goal session",
    reviews.every((row) => typeof row.parent_id === "string" && row.parent_id.length > 0),
  )
  const parents = new Set(reviews.map((row) => row.parent_id))
  check("all reviewer sessions share one parent", parents.size <= 1, `${parents.size} distinct parents`)
  db.close()
} else {
  notes.push(`skip session db assertions (no db at ${dbPath})`)
}

if (goalDir && fs.existsSync(goalDir)) {
  const files = fs.readdirSync(goalDir).filter((name) => name.endsWith(".json"))
  const state = files.map((name) => JSON.parse(fs.readFileSync(path.join(goalDir, name), "utf8")))
  const withChecklist = state.find((item) => Array.isArray(item.requirements) && item.requirements.length > 0)
  check("the checklist was persisted to durable goal state", Boolean(withChecklist))
  check(
    "per-attempt reviewer cost was recorded",
    state.some((item) => Array.isArray(item.review?.attemptStats) && item.review.attemptStats.length > 0),
  )
} else {
  notes.push(`skip goal state assertions (no dir at ${goalDir})`)
}

for (const note of notes) console.log(note)
for (const failure of failures) console.error(failure)
console.log(`${notes.filter((n) => n.startsWith("ok")).length} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
