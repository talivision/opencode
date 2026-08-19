// Assertions for fanout, stop-one, ownership, drop, soak, bad_marker, and marker_text_escape.
//
// Uses provider request logs plus SQLite's snake_case session_id, parent_id,
// and message_id columns. stop-one also consumes the provider's live-state
// endpoint because SessionStatus is deliberately process-local, not a DB table.
//
// node assert-scenarios.mjs <scenario> <provider.log> <opencode.db> <snap-dir> [provider-state.json]
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const [scenario, logPath, dbPath, snapDir, providerStatePath] = process.argv.slice(2)
const failures = []
const notes = []

function check(name, ok, detail) {
  if (ok) notes.push(`ok   ${name}`)
  else failures.push(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
}

if (!logPath || !fs.existsSync(logPath)) {
  console.error(`no provider log at ${logPath}`)
  process.exit(1)
}
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error(`no session db at ${dbPath}`)
  process.exit(1)
}

const entries = fs
  .readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const db = new DatabaseSync(dbPath, { readOnly: true })

function maxInWindow(items, duration) {
  return items.reduce((maximum, item, index) => {
    const count = items.slice(index).findIndex((next) => next.at - item.at >= duration)
    return Math.max(maximum, count < 0 ? items.length - index : count)
  }, 0)
}

if (scenario === "fanout") {
  const children = db
    .prepare(
      `SELECT id, parent_id, title,
              json_extract(model, '$.id') AS model_id,
              json_extract(model, '$.variant') AS variant
       FROM session
       WHERE parent_id IS NOT NULL AND title LIKE 'fanout %'
       ORDER BY title`,
    )
    .all()
  const notifications = db
    .prepare(
      `SELECT p.message_id, p.session_id, json_extract(p.data, '$.text') AS text
       FROM part p
       JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
       JOIN session s ON s.id = p.session_id
       WHERE s.parent_id IS NULL
         AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.text') LIKE '%<task-notification task_id=%status="completed"%'`,
    )
    .all()
  const childRequests = entries.filter((entry) => entry.role === "child")
  check("fanout created three child sessions", children.length === 3, `${children.length} children`)
  check(
    "each child session records its distinct per-call modelID",
    new Set(children.map((row) => row.model_id)).size === 3 &&
      ["fake-model-one", "fake-model-two", "fake-model-three"].every((model) =>
        children.some((row) => row.model_id === model),
      ),
    JSON.stringify(children),
  )
  check(
    "each child session records its per-call variant",
    new Set(children.map((row) => row.variant)).size === 3 &&
      ["low", "medium", "high"].every((variant) => children.some((row) => row.variant === variant)),
    JSON.stringify(children),
  )
  check(
    "the provider received one child request on each requested model",
    ["fake-model-one", "fake-model-two", "fake-model-three"].every((model) =>
      childRequests.some((entry) => entry.model === model),
    ),
  )
  check(
    "all three completion notifications arrived at the parent",
    notifications.length === 3,
    `${notifications.length} notifications`,
  )
}

if (scenario === "stop-one") {
  const children = db
    .prepare(
      `SELECT id, parent_id, title, json_extract(model, '$.id') AS model_id
       FROM session
       WHERE parent_id IS NOT NULL AND title LIKE '%cancellable task%'
       ORDER BY title`,
    )
    .all()
  const aborted = db
    .prepare(
      `SELECT DISTINCT m.session_id
       FROM message m
       JOIN session s ON s.id = m.session_id
       WHERE s.parent_id IS NOT NULL
         AND s.title LIKE '%cancellable task%'
         AND json_extract(m.data, '$.role') = 'assistant'
         AND json_extract(m.data, '$.error.name') = 'MessageAbortedError'`,
    )
    .all()
  const state =
    providerStatePath && fs.existsSync(providerStatePath)
      ? JSON.parse(fs.readFileSync(providerStatePath, "utf8"))
      : undefined
  const panes = fs.existsSync(snapDir)
    ? fs
        .readdirSync(snapDir)
        .filter((name) => name.endsWith(".txt"))
        .map((name) => fs.readFileSync(path.join(snapDir, name), "utf8"))
        .join("\n")
    : ""
  check("stop-one created two child sessions", children.length === 2, `${children.length} children`)
  check(
    "exactly one child durably records cancellation and returns idle",
    aborted.length === 1,
    `${aborted.length} MessageAbortedError sessions`,
  )
  check("the other child remains live at the provider", state?.activeChildModels?.length === 1, JSON.stringify(state))
  check(
    "the stopped child is no longer live while the other model remains",
    state?.activeChildModels?.length === 1 &&
      children.some((row) => row.model_id === state.activeChildModels[0]) &&
      children.some((row) => row.id === aborted[0]?.session_id && row.model_id !== state.activeChildModels[0]),
  )
  check("the running-tasks pane shows the stopped state", panes.includes("stopped") || panes.includes("Task stopped"))
}

if (scenario === "ownership") {
  const roots = db
    .prepare("SELECT id, parent_id, title FROM session WHERE parent_id IS NULL ORDER BY time_created, id")
    .all()
  const children = db
    .prepare("SELECT id, parent_id, title FROM session WHERE parent_id IS NOT NULL AND title LIKE 'owned child task%'")
    .all()
  const refusals = db
    .prepare(
      `SELECT p.message_id, p.session_id,
              coalesce(json_extract(p.data, '$.state.error'), json_extract(p.data, '$.state.output')) AS result
       FROM part p
       JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
       WHERE json_extract(p.data, '$.tool') = 'task'
         AND coalesce(json_extract(p.data, '$.state.error'), json_extract(p.data, '$.state.output')) LIKE '%not owned by session%'`,
    )
    .all()
  const childRequests = entries.filter((entry) => entry.role === "child")
  check("the driver created two independent parent sessions", roots.length >= 2, `${roots.length} roots`)
  check("parent A owns child A1", children.length === 1 && roots.some((root) => root.id === children[0].parent_id))
  check(
    "parent B's task(task_id=A1) call records the ownership refusal",
    refusals.length === 1 && roots.some((root) => root.id === refusals[0].session_id),
    `${refusals.length} refusal rows`,
  )
  check("the foreign prompt never reached A1", childRequests.length === 1, `${childRequests.length} child requests`)
  check(
    "the provider issued the explicit ownership probe",
    entries.some((entry) => entry.role === "ownership-attempt"),
  )
}

if (scenario === "drop") {
  const childRequests = entries.filter((entry) => entry.role === "child")
  const notifications = db
    .prepare(
      `SELECT json_extract(p.data, '$.text') AS text
       FROM part p
       JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
       JOIN session s ON s.id = p.session_id
       WHERE s.parent_id IS NULL
         AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.text') LIKE '%<task-notification task_id=%status="completed"%'`,
    )
    .all()
  check(
    "drop issued at least three child requests",
    childRequests.length >= 3,
    `${childRequests.length} child requests`,
  )
  check(
    "drop third child request carries the missing-marker reprompt",
    childRequests[2]?.doneMarkerMissing === true,
    JSON.stringify(
      childRequests.slice(0, 3).map((entry) => ({ n: entry.n, doneMarkerMissing: entry.doneMarkerMissing })),
    ),
  )
  check(
    "drop completion notification carries the task_done summary",
    notifications.some((row) => row.text?.includes("recovered after provider stream drop")),
    JSON.stringify(notifications),
  )
}

if (scenario === "soak") {
  const childRequests = entries.filter((entry) => entry.role === "child")
  const markerless = entries.filter((entry) => entry.role === "child-markerless-complete")
  const reprompts = childRequests.filter((entry) => [3, 5, 7].includes(entry.n))
  const gaps = markerless.map((entry, index) => reprompts[index]?.at - entry.at)
  const notifications = db
    .prepare(
      `SELECT json_extract(p.data, '$.text') AS text
       FROM part p
       JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
       JOIN session s ON s.id = p.session_id
       WHERE s.parent_id IS NULL
         AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.text') LIKE '%<task-notification task_id=%status="completed"%'`,
    )
    .all()
  const children = db.prepare("SELECT count(*) AS count FROM session WHERE parent_id IS NOT NULL").get()
  const unfinishedParent = db
    .prepare(
      `SELECT count(*) AS count
       FROM message m
       JOIN session s ON s.id = m.session_id
       WHERE s.parent_id IS NULL
         AND json_extract(m.data, '$.role') = 'assistant'
         AND json_extract(m.data, '$.time.completed') IS NULL`,
    )
    .get()
  const finalPane = fs.existsSync(path.join(snapDir, "final.txt"))
    ? fs.readFileSync(path.join(snapDir, "final.txt"), "utf8")
    : ""
  check(
    "soak missing-marker reprompts retain the 0s, 5s, 10s backoff spacing",
    markerless.length === 3 &&
      reprompts.length === 3 &&
      reprompts.every((entry) => entry.doneMarkerMissing === true) &&
      gaps.every(Number.isFinite) &&
      gaps[0] <= 2_000 &&
      gaps[1] >= 4_000 &&
      gaps[2] >= 8_000 &&
      gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1] * 0.8),
    `gaps=${gaps.map((gap) => Math.round(gap / 100) / 10).join(",")}s`,
  )
  check(
    "soak creates one child and delivers exactly one completed notification to the parent",
    children.count === 1 && notifications.length === 1,
    `${children.count} children, ${notifications.length} notifications`,
  )
  check(
    "soak completion notification carries the task_done summary",
    notifications[0]?.text?.includes("soak child recovered after three dropped turns"),
  )
  check(
    "soak has no 60-second child request storm",
    childRequests.every((entry) => Number.isFinite(entry.at)) && maxInWindow(childRequests, 60_000) <= 6,
    `maximum=${maxInWindow(childRequests, 60_000)}`,
  )
  check(
    "soak leaves the parent idle and the TUI alive with prompt chrome",
    // Footer chrome, not the agent chip: the pane renders "Build · Fake
    // Model" mixed-case, and the command hints are the stable alive marker.
    unfinishedParent.count === 0 && (finalPane.includes("ctrl+p") || finalPane.includes("shift+tab")),
    `unfinished parent messages=${unfinishedParent.count}`,
  )
}

if (scenario === "bad_marker") {
  const childRequests = entries.filter((entry) => entry.role === "child")
  const reprompt = childRequests.find((entry) => {
    const body = JSON.stringify(entry.body).toLowerCase()
    return entry.doneMarkerMissing === true && body.includes("summary") && body.includes("string")
  })
  const notifications = db
    .prepare(
      `SELECT json_extract(p.data, '$.text') AS text
       FROM part p
       JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
       JOIN session s ON s.id = p.session_id
       WHERE s.parent_id IS NULL
         AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.text') LIKE '%<task-notification task_id=%status="completed"%'`,
    )
    .all()
  check(
    "bad_marker reprompt carries the task_done summary validation error",
    reprompt !== undefined,
    JSON.stringify(childRequests.map((entry) => ({ n: entry.n, doneMarkerMissing: entry.doneMarkerMissing }))),
  )
  check(
    "bad_marker completes after the corrected task_done call",
    notifications.some((row) => row.text?.includes("recovered after invalid task_done arguments")),
    JSON.stringify(notifications),
  )
}

if (scenario === "marker_text_escape") {
  const childRequests = entries.filter((entry) => entry.role === "child")
  const notifications = db
    .prepare(
      `SELECT json_extract(p.data, '$.text') AS text
       FROM part p
       JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
       JOIN session s ON s.id = p.session_id
       WHERE s.parent_id IS NULL
         AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.text') LIKE '%<task-notification task_id=%status="completed"%'`,
    )
    .all()
  const taskDoneCalls = db
    .prepare(
      `SELECT count(*) AS count
       FROM part p
       JOIN session s ON s.id = p.session_id
       WHERE s.parent_id IS NOT NULL
         AND json_extract(p.data, '$.tool') = 'task_done'`,
    )
    .get()
  check(
    "marker_text_escape second reprompt advertises TASK_DONE",
    childRequests[2]?.markerTextEscape === true,
    JSON.stringify(childRequests.map((entry) => ({ n: entry.n, markerTextEscape: entry.markerTextEscape }))),
  )
  check("marker_text_escape child never calls task_done", taskDoneCalls.count === 0, `${taskDoneCalls.count} calls`)
  check(
    "marker_text_escape completion notification carries the text summary",
    notifications.some((row) => row.text?.includes("escaped via text marker")),
    JSON.stringify(notifications),
  )
}

db.close()
for (const note of notes) console.log(note)
for (const failure of failures) console.error(failure)
console.log(`${notes.length} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
