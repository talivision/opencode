// Assertions for the additional goal harness scenarios.
//
// Sources of truth:
//   * provider.log for exact request bodies and request ordering
//   * the session sqlite db (snake_case session_id, parent_id, message_id)
//   * durable storage/goal JSON for goal counters and terminal state
//   * captured TUI panes for the rendered completion indication
//
// node assert-scenarios.mjs <scenario> <provider.log> <opencode.db> <goal-dir> <snap-dir> [interrupted-snapshot]
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const [scenario, logPath, dbPath, goalDir, snapDir, interruptedSnapshot] = process.argv.slice(2)
const failures = []
const notes = []

function check(name, ok, detail) {
  if (ok) notes.push(`ok   ${name}`)
  else failures.push(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}

function readJsonLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function readGoal(fileOrDirectory) {
  if (!fileOrDirectory || !fs.existsSync(fileOrDirectory)) return
  if (fs.statSync(fileOrDirectory).isFile()) return JSON.parse(fs.readFileSync(fileOrDirectory, "utf8"))
  const file = fs.readdirSync(fileOrDirectory).find((name) => name.endsWith(".json"))
  return file ? JSON.parse(fs.readFileSync(path.join(fileOrDirectory, file), "utf8")) : undefined
}

function systemMessage(entry) {
  return JSON.stringify(entry.body.messages?.filter((message) => message.role === "system") ?? [])
}

function reviewState(system) {
  return /Independent review attempt \d+ did not accept completion:/.exec(system)?.[0] ??
    /Independent review attempt \d+ is (?:pending|running)\./.exec(system)?.[0] ??
    "no-review"
}

if (!logPath || !fs.existsSync(logPath)) {
  console.error(`no provider log at ${logPath}`)
  process.exit(1)
}
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error(`no session db at ${dbPath}`)
  process.exit(1)
}

const entries = readJsonLines(logPath)
const workers = entries.filter((entry) => entry.role === "worker")
const reviewers = entries.filter((entry) => entry.role === "reviewer")
const goal = readGoal(goalDir)
const db = new DatabaseSync(dbPath, { readOnly: true })

if (scenario === "not_met_history") {
  const third = JSON.stringify(workers[2]?.body ?? {})
  check("the worker reached a third request", workers.length >= 3, `${workers.length} worker requests`)
  check("the third worker request carries the active-goal status header", third.includes("Current active-goal status for this turn:"))
  check(
    "the third worker request carries the latest rejection",
    third.includes("beta regression remains unresolved after the latest worker turn"),
  )
  check(
    "the third worker request carries the earlier rejection under the anti-cycling heading",
    third.includes("Earlier attempts were also rejected") &&
      third.includes("alpha evidence is missing from the authoritative state"),
  )
}

if (scenario === "turns") {
  const globCalls = workers.filter((entry) =>
    JSON.stringify(entry.body).includes('"name":"glob"'),
  )
  check("the worker made two glob tool-call steps", globCalls.length >= 2, `${globCalls.length} glob requests`)
  check("the multi-step worker turn is counted once", goal?.turns === 1, `turns=${goal?.turns}`)
}

if (scenario === "interrupted") {
  const interrupted = readGoal(interruptedSnapshot)
  const resumed = JSON.stringify(workers[1]?.body ?? {})
  const reviewRows = db
    .prepare("SELECT id, parent_id, title FROM session WHERE parent_id IS NOT NULL AND title LIKE 'Goal review%'")
    .all()
  const firstReviewIndex = entries.findIndex((entry) => entry.role === "reviewer")
  const resumedIndex = entries.findIndex((entry) => entry.role === "worker" && entry.n === 2)
  check("the failed turn was durably recorded as interrupted", interrupted?.interrupted?.count === 1)
  check(
    "the durable interruption records the non-retryable provider error",
    interrupted?.interrupted?.reason?.includes("GOAL_HARNESS_PROVIDER_400"),
  )
  check("the worker resumed after the failed turn", workers.length >= 2)
  check(
    "the resumed worker request carries interruption context",
    resumed.includes("Current active-goal status for this turn:") &&
      resumed.includes("Consecutive interrupted goal turns: 1") &&
      resumed.includes("GOAL_HARNESS_PROVIDER_400"),
  )
  check(
    "no reviewer ran for the failed turn",
    reviewers.length === 1 && firstReviewIndex > resumedIndex,
    `${reviewers.length} reviewer requests, resumed index ${resumedIndex}, review index ${firstReviewIndex}`,
  )
  check("only the recovered clean turn created a reviewer child session", reviewRows.length === 1, `${reviewRows.length} rows`)
  notes.push("note first consecutive interruption intentionally has 0ms outer backoff; no delay assertion applies")
}

if (scenario === "cache-stable") {
  // Review state legitimately changes the active-goal block at a review
  // boundary. Compare only adjacent worker requests whose state label matches.
  const comparisons = workers
    .slice(1)
    .map((entry, index) => [workers[index], entry])
    .filter(([left, right]) => reviewState(systemMessage(left)) === reviewState(systemMessage(right)))
  const stableRun = workers.some((entry, index) => {
    const next = workers[index + 1]
    const after = workers[index + 2]
    return (
      next &&
      after &&
      reviewState(systemMessage(entry)) === reviewState(systemMessage(next)) &&
      reviewState(systemMessage(next)) === reviewState(systemMessage(after))
    )
  })
  check("at least three consecutive worker requests share one review state", stableRun)
  check(
    "the system message is byte-identical between consecutive requests in one review state",
    comparisons.length > 0 && comparisons.every(([left, right]) => systemMessage(left) === systemMessage(right)),
    `${comparisons.length} comparisons`,
  )
  const activeGoalBlocks = workers.map(systemMessage).filter((system) => system.includes("<active-goal>"))
  check(
    "the active-goal system block omits volatile accounting",
    activeGoalBlocks.length > 0 &&
      activeGoalBlocks.every(
        (system) =>
          !system.includes("Current active-goal status for this turn:") &&
          !system.includes("Token budget:") &&
          !system.includes("completed goal turn(s)"),
      ),
  )
}

if (scenario === "goal-events") {
  const panes = fs.existsSync(snapDir)
    ? fs
        .readdirSync(snapDir)
        .filter((name) => name.endsWith(".txt"))
        .map((name) => fs.readFileSync(path.join(snapDir, name), "utf8"))
        .join("\n")
    : ""
  const accepted = db
    .prepare(
      `SELECT count(*) AS count
       FROM part p
       JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
       WHERE json_extract(p.data, '$.tool') = 'goal-review'
         AND json_extract(p.data, '$.state.metadata.verdict') = 'accepted'`,
    )
    .get()
  check("the TUI pane renders the real Goal achieved indication", panes.includes("Goal achieved"))
  check("durable goal state records completion", goal?.status === "complete", `status=${goal?.status}`)
  check("the session db records an accepted goal-review part", accepted.count > 0, `${accepted.count} rows`)
}

db.close()
for (const note of notes) console.log(note)
for (const failure of failures) console.error(failure)
console.log(`${notes.filter((note) => note.startsWith("ok")).length} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
