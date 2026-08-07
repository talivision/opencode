// Isolated fake OpenAI-compatible provider for the permission/compaction
// harness. It never contacts a real provider.
//
// Classification is deliberately structural and marker-based. In particular,
// a compaction request is identified only when one system message exactly
// equals the compaction agent's distinct system prompt. Generic words such as
// "summary" and "compact" are never classifiers.
//
// env:
//   PORT      listen port (default 4599)
//   LOG       path to append one JSON line per real provider request
//   SCENARIO  auto-suppresses | auto-inherits | deny-wins | grant-persists | compaction
//   PERMISSION_HARNESS_NO_LISTEN=1  import classifier without opening a listener
import http from "node:http"
import fs from "node:fs"

const PORT = Number(process.env.PORT ?? 4599)
const LOG = process.env.LOG
const SCENARIO = process.env.SCENARIO ?? "auto-suppresses"
const USAGE = { input: 100, output: 10 }
const COMPACTION_USAGE = { input: 900, output: 180 }
const COMPACTION_FILL = "context-fill ".repeat(320)

const COMPACTION_MARKER = "anchored context summarization assistant"
const COMPACTION_SYSTEM = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`
const TITLE_SYSTEM = "You are a title generator. You output ONLY a thread title. Nothing else."
const COMPACTION_CONTINUE =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

const MARKERS = {
  autoSuppressesControl: "PERMISSION_HARNESS_AUTO_SUPPRESSES_CONTROL",
  autoSuppressesActive: "PERMISSION_HARNESS_AUTO_SUPPRESSES_ACTIVE",
  autoInheritsPreflight: "PERMISSION_HARNESS_AUTO_INHERITS_PREFLIGHT",
  autoInheritsParent: "PERMISSION_HARNESS_AUTO_INHERITS_PARENT",
  autoInheritsChild: "PERMISSION_HARNESS_AUTO_INHERITS_CHILD",
  denyWinsPreflight: "PERMISSION_HARNESS_DENY_WINS_PREFLIGHT",
  denyWins: "PERMISSION_HARNESS_DENY_WINS",
  grantPersistsFirst: "PERMISSION_HARNESS_GRANT_PERSISTS_FIRST",
  grantPersistsSecond: "PERMISSION_HARNESS_GRANT_PERSISTS_SECOND",
}

const CALLS = {
  autoSuppressesControl: "call_permission_auto_control",
  autoSuppressesActive: "call_permission_auto_active",
  autoInheritsTask: "call_permission_inherits_task",
  autoInheritsChild: "call_permission_inherits_child_bash",
  denyWinsBenign: "call_permission_deny_benign",
  denyWinsDenied: "call_permission_deny_explicit",
  grantPersistsFirst: "call_permission_grant_first",
  grantPersistsSecond: "call_permission_grant_second",
}

const stats = {
  requests: 0,
  summary: 0,
  title: 0,
  worker: 0,
  unknown: 0,
}
let summarySeen = false

function log(entry) {
  if (!LOG) return
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n")
}

function chunk(input) {
  return {
    id: "chatcmpl-permission-harness",
    object: "chat.completion.chunk",
    choices: [{ delta: input.delta ?? {}, ...(input.finish ? { finish_reason: input.finish } : {}) }],
    ...(input.usage
      ? {
          usage: {
            prompt_tokens: input.usage.input,
            completion_tokens: input.usage.output,
            total_tokens: input.usage.input + input.usage.output,
          },
        }
      : {}),
  }
}

function sse(res, lines) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  for (const line of lines) res.write(`data: ${JSON.stringify(line)}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
}

function textReply(res, value, usage = USAGE) {
  sse(res, [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { content: value } }),
    chunk({ finish: "stop", usage }),
  ])
}

function toolReply(res, name, args, id) {
  const input = JSON.stringify(args)
  const split = Math.ceil(input.length / 2)
  sse(res, [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: input.slice(0, split) } }] } }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: input.slice(split) } }] } }),
    chunk({ finish: "tool_calls", usage: USAGE }),
  ])
}

async function readBody(req) {
  const parts = []
  for await (const part of req) parts.push(part)
  return Buffer.concat(parts).toString("utf8")
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      if (typeof part.text === "string") return part.text
      return ""
    })
    .join("\n")
}

function messages(parsed, role) {
  if (!Array.isArray(parsed.messages)) return []
  return parsed.messages.filter((message) => message?.role === role)
}

function lastToolResult(parsed) {
  if (!Array.isArray(parsed.messages)) return
  const message = parsed.messages.at(-1)
  if (message?.role !== "tool") return
  return message.tool_call_id
}

function scenarioMarkers(userText) {
  const labels = new Set()
  for (const value of userText) {
    if (value.includes(MARKERS.autoSuppressesControl) || value.includes(MARKERS.autoSuppressesActive))
      labels.add("auto-suppresses")
    if (
      value.includes(MARKERS.autoInheritsPreflight) ||
      value.includes(MARKERS.autoInheritsParent) ||
      value.includes(MARKERS.autoInheritsChild)
    )
      labels.add("auto-inherits")
    if (value.includes(MARKERS.denyWinsPreflight) || value.includes(MARKERS.denyWins)) labels.add("deny-wins")
    if (value.includes(MARKERS.grantPersistsFirst) || value.includes(MARKERS.grantPersistsSecond))
      labels.add("grant-persists")
    if (/PERMISSION_HARNESS_COMPACTION_TURN_[1-8]/.test(value)) labels.add("compaction")
  }
  return [...labels]
}

function classify(parsed, url) {
  if (url.startsWith("/v1/models")) return { classification: "models", summarySystemMatches: 0 }

  const systemText = messages(parsed, "system").map((message) => contentText(message.content))
  const userText = messages(parsed, "user").map((message) => contentText(message.content))
  // Substring, NOT equality: request.ts joins the whole system array into a
  // single message (agent prompt + instructions + skills + ...), so the
  // compaction prompt never arrives alone and `===` can never match. The
  // marker below appears in exactly one prompt file in the repo, so it is
  // unambiguous without being brittle — the control assertion proves a normal
  // turn scores zero.
  const summarySystemMatches = systemText.filter((value) => value.includes(COMPACTION_MARKER)).length
  if (summarySystemMatches > 1) return { classification: "ambiguous", reason: "multiple-compaction-systems", summarySystemMatches }
  if (summarySystemMatches === 1) return { classification: "summary", scenario: "compaction", summarySystemMatches }

  const titleSystemMatches = systemText.filter((value) => value.startsWith(TITLE_SYSTEM)).length
  if (titleSystemMatches > 1) return { classification: "ambiguous", reason: "multiple-title-systems", summarySystemMatches }
  if (titleSystemMatches === 1) return { classification: "title", summarySystemMatches }

  const scenarios = scenarioMarkers(userText)
  if (scenarios.length > 1)
    return { classification: "ambiguous", reason: "multiple-scenario-markers", scenarios, summarySystemMatches }
  if (scenarios.length === 0) return { classification: "unknown", summarySystemMatches }

  const scenario = scenarios[0]
  const lastUser = userText.at(-1) ?? ""
  if (scenario === "compaction" && lastUser.includes(COMPACTION_CONTINUE))
    return { classification: "worker", scenario, phase: "continuation", summarySystemMatches }

  const resultID = lastToolResult(parsed)
  const resultPhase = Object.entries(CALLS).find(([, id]) => id === resultID)?.[0]
  if (resultPhase)
    return { classification: "worker", scenario, phase: `${resultPhase}-result`, summarySystemMatches }

  // Longest first matters for the intentional DENY_WINS / DENY_WINS_PREFLIGHT
  // prefix pair. A broad-prefix match must never steal the more specific case.
  const marker = Object.entries(MARKERS)
    .sort((left, right) => right[1].length - left[1].length)
    .find(([, value]) => lastUser.includes(value))?.[0]
  if (marker) return { classification: "worker", scenario, phase: marker, summarySystemMatches }
  const turn = /PERMISSION_HARNESS_COMPACTION_TURN_([1-8])/.exec(lastUser)?.[1]
  if (turn) return { classification: "worker", scenario, phase: `compaction-turn-${turn}`, turn: Number(turn), summarySystemMatches }
  return { classification: "unknown", scenario, summarySystemMatches }
}

export { classify }

function compactionUsage(turn) {
  if (summarySeen) return { input: 700 + turn * 100, output: 20 }
  return {
    input: [0, 1_500, 3_000, 5_000, 7_000, 8_500, 11_000, 11_000, 11_000][turn] ?? 11_000,
    output: 20,
  }
}

function reportedPromptTokens(result) {
  if (result.classification === "summary") return COMPACTION_USAGE.input
  if (result.phase === "continuation") return 600
  if (result.scenario === "compaction" && result.turn) return compactionUsage(result.turn).input
  return USAGE.input
}

function respondWorker(res, parsed, result) {
  const phase = result.phase

  if (phase === "autoSuppressesControl") {
    toolReply(res, "bash", { command: "printf auto-control" }, CALLS.autoSuppressesControl)
    return
  }
  if (phase === "autoSuppressesActive") {
    toolReply(res, "bash", { command: "printf auto-active" }, CALLS.autoSuppressesActive)
    return
  }
  if (phase === "autoSuppressesControl-result" || phase === "autoSuppressesActive-result") {
    textReply(res, "auto-suppresses tool completed")
    return
  }

  if (phase === "autoInheritsPreflight" || phase === "denyWinsPreflight") {
    textReply(res, "preflight complete")
    return
  }
  if (phase === "autoInheritsParent") {
    toolReply(
      res,
      "task",
      {
        description: "permission inheritance probe",
        prompt: `${MARKERS.autoInheritsChild}: run the requested shell probe`,
        subagent_type: "general",
      },
      CALLS.autoInheritsTask,
    )
    return
  }
  if (phase === "autoInheritsChild") {
    toolReply(res, "bash", { command: "printf inherited-child" }, CALLS.autoInheritsChild)
    return
  }
  if (phase === "autoInheritsChild-result") {
    textReply(res, "child shell probe completed")
    return
  }
  if (phase === "autoInheritsTask-result") {
    textReply(res, "parent observed child completion")
    return
  }

  if (phase === "denyWins") {
    toolReply(res, "bash", { command: "printf benign-auto-allowed" }, CALLS.denyWinsBenign)
    return
  }
  if (phase === "denyWinsBenign-result") {
    toolReply(res, "bash", { command: "rm -rf /tmp/x" }, CALLS.denyWinsDenied)
    return
  }
  if (phase === "denyWinsDenied-result") {
    textReply(res, "deny-wins probe completed")
    return
  }

  if (phase === "grantPersistsFirst") {
    toolReply(res, "bash", { command: "printf grant-persisted" }, CALLS.grantPersistsFirst)
    return
  }
  if (phase === "grantPersistsSecond") {
    toolReply(res, "bash", { command: "printf grant-persisted" }, CALLS.grantPersistsSecond)
    return
  }
  if (phase === "grantPersistsFirst-result" || phase === "grantPersistsSecond-result") {
    textReply(res, "grant persistence probe completed")
    return
  }

  if (phase === "continuation") {
    textReply(res, "post-compaction continuation completed", { input: 600, output: 20 })
    return
  }
  if (result.scenario === "compaction" && result.turn) {
    // The measured usage drives the durable overflow trigger. The filler makes
    // the serialized transcript estimate grow too, which independently drives
    // dynamic max_tokens sizing in request preparation.
    textReply(res, `compaction turn ${result.turn} completed\n${COMPACTION_FILL}`, compactionUsage(result.turn))
    return
  }

  textReply(res, `unhandled worker phase: ${phase ?? "unknown"}`)
}

const server = http.createServer(async (req, res) => {
  const raw = await readBody(req)
  let parsed = {}
  try {
    parsed = JSON.parse(raw || "{}")
  } catch {}

  if (req.url === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(stats))
    return
  }
  if (req.url === "/__classify") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(classify(parsed, "/v1/chat/completions")))
    return
  }

  const result = classify(parsed, req.url ?? "")
  if (result.classification === "models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [] }))
    return
  }
  if (result.classification === "ambiguous") {
    log({ ...result, url: req.url, body: parsed })
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: `ambiguous harness request: ${result.reason}` } }))
    return
  }

  stats.requests += 1
  if (result.classification in stats) stats[result.classification] += 1
  log({
    ...result,
    request: stats.requests,
    max_tokens: parsed.max_tokens ?? parsed.max_completion_tokens ?? null,
    reported_prompt_tokens: reportedPromptTokens(result),
    url: req.url,
    body: parsed,
  })

  if (result.classification === "summary") {
    summarySeen = true
    textReply(
      res,
      "## Objective\n- Continue the permission harness compaction run.\n\n## Important Details\n- Preserve the exact turn markers.\n\n## Work State\n### Completed\n- Earlier turns completed.\n\n### Active\n- Continue after compaction.\n\n### Blocked\n- (none)\n\n## Next Move\n1. Continue the session.\n2. Complete a later user turn.\n\n## Relevant Files\n- script/permission-harness/: harness files.",
      COMPACTION_USAGE,
    )
    return
  }
  if (result.classification === "title") {
    textReply(res, "Permission harness probe")
    return
  }
  if (result.classification === "worker") {
    if (result.scenario !== SCENARIO) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `expected ${SCENARIO}, received ${result.scenario}` } }))
      return
    }
    respondWorker(res, parsed, result)
    return
  }

  textReply(res, "auxiliary request completed")
})

if (process.env.PERMISSION_HARNESS_NO_LISTEN !== "1") {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`fake provider listening on http://127.0.0.1:${PORT} (${SCENARIO})`)
  })
}
