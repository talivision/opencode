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
  else failures.push(`not ok ${name}${detail ? ` — ${detail}` : ""}`)
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
  return (
    /Independent review attempt \d+ did not accept completion:/.exec(system)?.[0] ??
    /Independent review attempt \d+ is (?:pending|running)\./.exec(system)?.[0] ??
    "no-review"
  )
}

function partRows(tool) {
  return db
    .prepare(
      "SELECT session_id, data FROM part WHERE json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') = ?",
    )
    .all(tool)
    .map((row) => ({ sessionID: row.session_id, data: JSON.parse(row.data) }))
}

function messageText(message) {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")
}

function reviewerToolResults(callID) {
  return reviewers.flatMap((entry) =>
    (entry.body.messages ?? [])
      .filter((message) => message.role === "tool" && message.tool_call_id === callID)
      .map((message) => messageText(message)),
  )
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

if (scenario === "unclaimed") {
  const firstReviewer = entries.findIndex((entry) => entry.role === "reviewer")
  const secondWorker = entries.findIndex((entry) => entry.role === "worker" && entry.n === 2)
  const reminder = "Your turn ended without calling the goal tool"
  const reminderParts = db
    .prepare(
      "SELECT count(*) AS count FROM part WHERE json_extract(data, '$.type') = 'text' AND json_extract(data, '$.synthetic') = 1 AND json_extract(data, '$.text') LIKE ?",
    )
    .get(`%${reminder}%`)
  const reviewSessions = db
    .prepare("SELECT count(*) AS count FROM session WHERE parent_id IS NOT NULL AND title LIKE 'Goal review #1%'")
    .get()
  const reviewSeeds = reviewers.filter(
    (entry) => !(entry.body.messages ?? []).some((message) => message.role === "tool"),
  )
  check("the first worker turn returned plain text without requesting completion", workers.length >= 2)
  check(
    "no reviewer request ran before the reminder re-invoked the worker",
    secondWorker > 0 && firstReviewer > secondWorker,
    `second worker index ${secondWorker}, first reviewer index ${firstReviewer}`,
  )
  check("the unclaimed-turn reminder is persisted as a synthetic user part", reminderParts.count === 1)
  check("the reminder reached the worker's second request", JSON.stringify(workers[1]?.body ?? {}).includes(reminder))
  check(
    "the later completion claim launched exactly one review attempt",
    reviewSeeds.length === 1 && reviewSessions.count === 1,
    `${reviewSeeds.length} seeds, ${reviewSessions.count} sessions`,
  )
  check(
    "the structured review completes the goal and resets the reminder streak",
    goal?.status === "complete" &&
      goal.review?.status === "accepted" &&
      goal.review?.attempt === 1 &&
      !goal.reminderStreak,
  )
}

if (scenario === "not_met_history") {
  const later = workers.find((entry) => JSON.stringify(entry.body).includes("Earlier attempts were also rejected"))
  const body = JSON.stringify(later?.body ?? {})
  check(
    "the worker reached a later request after two rejected attempts",
    workers.length >= 5,
    `${workers.length} worker requests`,
  )
  check(
    "the later worker request carries the active-goal status header",
    body.includes("Current active-goal status for this turn:"),
  )
  check(
    "the later worker request carries the latest rejection",
    body.includes("beta regression remains unresolved after the latest worker turn"),
  )
  check(
    "the later worker request carries the earlier rejection under the anti-cycling heading",
    body.includes("Earlier attempts were also rejected") &&
      body.includes("alpha evidence is missing from the authoritative state"),
  )
}

if (scenario === "turns") {
  const globCalls = workers.filter((entry) => JSON.stringify(entry.body).includes('"name":"glob"'))
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
  const claimIndex = entries.findIndex((entry) => entry.role === "worker" && entry.n === 3)
  const followupIndex = entries.findIndex((entry) => entry.role === "worker" && entry.n === 4)
  check("the failed turn was durably recorded as interrupted", interrupted?.interrupted?.count === 1)
  check(
    "the durable interruption records the non-retryable provider error",
    interrupted?.interrupted?.reason?.includes("GOAL_HARNESS_PROVIDER_400"),
  )
  check("the worker resumed after the failed turn", workers.length === 4, `${workers.length} worker requests`)
  check(
    "the resumed worker request carries interruption context",
    resumed.includes("Current active-goal status for this turn:") &&
      resumed.includes("Consecutive interrupted goal turns: 1") &&
      resumed.includes("GOAL_HARNESS_PROVIDER_400"),
  )
  check(
    "no reviewer ran before the recovered turn's claim follow-up ended",
    resumedIndex >= 0 && claimIndex > resumedIndex && followupIndex > claimIndex && firstReviewIndex > followupIndex,
    `resumed index ${resumedIndex}, claim index ${claimIndex}, follow-up index ${followupIndex}, first review request index ${firstReviewIndex}`,
  )
  check(
    "only the recovered clean turn created a reviewer child session",
    reviewRows.length === 1,
    `${reviewRows.length} rows`,
  )
  // The accepting review is the last thing that may talk to the provider. A
  // request after it is a continuation issued against a goal that is already
  // complete: it carries no <active-goal> block (so it logs as auxiliary), it
  // costs a full round trip, and it is the observable symptom of a continuation
  // decided on a stale goal snapshot.
  const afterLastReview = entries.slice(entries.findLastIndex((entry) => entry.role === "reviewer") + 1)
  check(
    "nothing is prompted after the accepting review",
    afterLastReview.length === 0,
    afterLastReview.map((entry) => entry.role).join(", "),
  )
  notes.push("note first consecutive interruption intentionally has 0ms outer backoff; no delay assertion applies")
}

if (scenario === "permission_blocked_pending") {
  const reviews = partRows("goal-review")
  const running = reviews.find((part) => part.data.state.status === "running")
  const reads = partRows("read")
  const panes = fs.existsSync(snapDir)
    ? fs
        .readdirSync(snapDir)
        .filter((name) => name.startsWith("permission-") && name.endsWith(".txt"))
        .map((name) => fs.readFileSync(path.join(snapDir, name), "utf8"))
        .join("\n")
    : ""
  // Each predicate has an opposing observable failure: a charged watchdog
  // changes the durable attempt/part to error, a missing gate leaves no running
  // read or waiting activity, and a UI regression removes the permission pane.
  check(
    "the same durable review attempt is still running",
    goal?.review?.status === "running" && goal.review.attempt === 1,
  )
  check(
    "the running review part is older than the configured 5s limits",
    running?.data.state.time?.start && Date.now() - running.data.state.time.start >= 7000,
    `age=${running?.data.state.time?.start ? Date.now() - running.data.state.time.start : "missing"}ms`,
  )
  check(
    "the durable review part publishes the permission wait",
    running?.data.state.metadata?.activity === "Waiting for permission approval",
    `activity=${running?.data.state.metadata?.activity}`,
  )
  check(
    "the reviewer read remains blocked on the controlled external file",
    reads.some(
      (part) =>
        part.data.state.status === "running" && part.data.state.input?.filePath?.endsWith("/reviewer-outside.txt"),
    ),
  )
  check(
    "no timeout error was recorded while permission was pending",
    !reviews.some(
      (part) => part.data.state.status === "error" && String(part.data.state.error ?? "").includes("timed out"),
    ) &&
      !goal?.review?.errorStreak &&
      !String(goal?.review?.reason ?? "").includes("timed out"),
  )
  check(
    "the pane shows the external-directory permission waiting state",
    panes.includes("Permission required") && panes.includes("Access external directory"),
  )
}

if (scenario === "permission_blocked") {
  const reviews = partRows("goal-review")
  const readResults = reviewerToolResults("call_permission_read")
  // These fail respectively if approval did not resume the child, if it timed
  // out/retried, if the read result never reached the reviewer, or if the parent
  // transcript did not receive the accepted verdict.
  check(
    "permission approval lets the review reach completion",
    goal?.status === "complete" && goal.review?.status === "accepted",
  )
  check(
    "permission approval completes the original durable attempt",
    goal?.review?.attempt === 1,
    `attempt=${goal?.review?.attempt}`,
  )
  check(
    "the approved read result reached the reviewer as a tool result",
    readResults.some((output) => output.includes("GOAL_HARNESS_PERMISSION_APPROVED")),
  )
  check(
    "the parent transcript records the accepted permission-blocked review",
    reviews.some(
      (part) =>
        part.sessionID === goal?.sessionID &&
        part.data.state.status === "completed" &&
        part.data.state.metadata?.verdict === "accepted" &&
        part.data.state.output?.includes("controlled external evidence was read"),
    ),
  )
  check(
    "the completed permission-blocked review has no timeout part",
    !reviews.some(
      (part) => part.data.state.status === "error" && String(part.data.state.error ?? "").includes("timed out"),
    ),
  )
}

if (scenario === "goal_check") {
  const checks = partRows("goal_check")
  const exact = checks.find((part) => part.data.state.input?.command === "printf goal-check-ok")
  const near = checks.find((part) => part.data.state.input?.command === "printf goal-check-ok-extra")
  const exactResults = reviewerToolResults("call_goal_check_exact")
  const refusedResults = reviewerToolResults("call_goal_check_refused")
  const parentReviews = partRows("goal-review").filter((part) => part.sessionID === goal?.sessionID)
  // The provider-log checks are deliberately scoped to role=tool plus the
  // exact call id. The near-miss command also appears in an assistant tool-call
  // input, so an unscoped substring assertion would pass even if refusal broke.
  check(
    "the exact configured goal_check command ran successfully",
    exact?.data.state.status === "completed" &&
      exact.data.state.metadata?.exit === 0 &&
      exact.data.state.output?.includes("goal-check-ok"),
  )
  check(
    "the exact command output reached the reviewer tool-result message",
    exactResults.some((output) => output.includes("Exit code: 0") && output.includes("goal-check-ok")),
  )
  check(
    "the near-miss was refused before execution",
    near?.data.state.status === "completed" &&
      near.data.state.metadata?.refused === true &&
      !("exit" in (near.data.state.metadata ?? {})) &&
      !near.data.state.output?.includes("Exit code:"),
  )
  check(
    "the refusal tool result names the configured allowed command",
    refusedResults.some(
      (output) =>
        output.includes("Command refused: it does not exactly match") &&
        output.includes("Allowed commands:") &&
        output.includes("- printf goal-check-ok"),
    ),
  )
  check(
    "the parent transcript receives the reviewer's command/refusal verdict",
    parentReviews.some(
      (part) =>
        part.data.state.status === "completed" &&
        part.data.state.metadata?.verdict === "accepted" &&
        part.data.state.output?.includes("exact command produced goal-check-ok") &&
        part.data.state.output?.includes("near-miss was refused"),
    ),
  )
}

if (scenario === "silent") {
  const reviews = partRows("goal-review")
  const timedOut = reviews.filter(
    (part) =>
      part.data.state.status === "error" &&
      String(part.data.state.error ?? "").includes("timed out after 5s without activity"),
  )
  // A broken control leaves no inactivity error; using durable attempt rather
  // than reviewer HTTP count also prevents SDK retries from masquerading as
  // separate goal-level review attempts.
  check("the silent reviewer still hits the inactivity watchdog", timedOut.length > 0)
  check(
    "silent-review continuation advances the durable attempt",
    goal?.review?.attempt >= 2,
    `attempt=${goal?.review?.attempt}`,
  )
  check(
    "the silent timeout is durably costed as a finished attempt",
    goal?.review?.attemptStats?.some((stat) => stat.durationMs >= 5000),
  )
}

if (scenario === "http500") {
  const reviewSessions = db
    .prepare("SELECT id FROM session WHERE parent_id IS NOT NULL AND title LIKE 'Goal review #%'")
    .all()
  // One child session is created per durable attempt; several timestamped HTTP
  // requests may belong to that one child because the SDK retries a 500.
  check(
    "HTTP retries do not inflate the durable review-attempt count",
    goal?.review?.attempt === reviewSessions.length,
    `attempt=${goal?.review?.attempt}, child sessions=${reviewSessions.length}`,
  )
  check(
    "reviewer request log lines carry timestamps for retry/backoff analysis",
    reviewers.length > 0 && reviewers.every((entry) => Number.isFinite(entry.at)),
  )
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
