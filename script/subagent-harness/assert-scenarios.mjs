// Assertions for fanout, stop-one, and ownership.
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
  check("all three completion notifications arrived at the parent", notifications.length === 3, `${notifications.length} notifications`)
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
  check(
    "the other child remains live at the provider",
    state?.activeChildModels?.length === 1,
    JSON.stringify(state),
  )
  check(
    "the stopped child is no longer live while the other model remains",
    state?.activeChildModels?.length === 1 &&
      children.some((row) => row.model_id === state.activeChildModels[0]) &&
      children.some((row) => row.id === aborted[0]?.session_id && row.model_id !== state.activeChildModels[0]),
  )
  check(
    "the running-tasks pane shows the stopped state",
    panes.includes("stopped") || panes.includes("Task stopped"),
  )
}

if (scenario === "ownership") {
  const roots = db.prepare("SELECT id, parent_id, title FROM session WHERE parent_id IS NULL ORDER BY time_created, id").all()
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
  check("the provider issued the explicit ownership probe", entries.some((entry) => entry.role === "ownership-attempt"))
}

db.close()
for (const note of notes) console.log(note)
for (const failure of failures) console.error(failure)
console.log(`${notes.length} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
