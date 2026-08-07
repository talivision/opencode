// Isolated fake OpenAI-compatible provider used to exercise background
// subagents deterministically. Never contacts a real provider.
//
// Request classification uses prompt markers carried in the transcript:
//   * parent request -> contains PARENT_MARKER, the driver's first user prompt
//   * child request  -> everything else; task prompts contain CHILD_MARKER
// The child gets a separate system prompt and transcript, so it does not inherit
// PARENT_MARKER. Title-generation requests have no tools and get a quick reply
// without advancing either scenario.
//
// env:
//   PORT      listen port (default 4599)
//   LOG       path to append one JSON line per request
//   SCENARIO  notify | steer | inspect (default notify)
import http from "node:http"
import fs from "node:fs"

const PORT = Number(process.env.PORT ?? 4599)
const LOG = process.env.LOG
const SCENARIO = process.env.SCENARIO ?? "notify"
const PARENT_MARKER = "Spawn a background investigation and then wait."
const CHILD_MARKER = "SUBAGENT_HARNESS_CHILD"
const USAGE = { input: 100, output: 10 }

let parentCount = 0
let childCount = 0
let childID
let firstChildOpen = false
let inspectStopIssued = false

function log(entry) {
  if (!LOG) return
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n")
}

function chunk(input) {
  return {
    id: "chatcmpl-fake",
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
  for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
}

function textReply(res, text, usage = USAGE) {
  sse(res, [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { content: text } }),
    chunk({ finish: "stop", usage }),
  ])
}

function toolReply(res, name, args, id = "call_1") {
  const input = JSON.stringify(args)
  const split = Math.ceil(input.length / 2)
  sse(res, [
    chunk({ delta: { role: "assistant" } }),
    chunk({
      delta: {
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
      },
    }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: input.slice(0, split) } }] } }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: input.slice(split) } }] } }),
    chunk({ finish: "tool_calls", usage: USAGE }),
  ])
}

function slowTextReply(req, res, text, duration, track = false) {
  const pieces = text.split(" ")
  if (track) firstChildOpen = true
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.write(`data: ${JSON.stringify(chunk({ delta: { role: "assistant" } }))}\n\n`)
  let index = 0
  const timer = setInterval(
    () => {
      if (index < pieces.length) {
        const suffix = index === pieces.length - 1 ? "" : " "
        res.write(`data: ${JSON.stringify(chunk({ delta: { content: pieces[index] + suffix } }))}\n\n`)
        index += 1
        return
      }
      clearInterval(timer)
      if (track) firstChildOpen = false
      res.write(`data: ${JSON.stringify(chunk({ finish: "stop", usage: USAGE }))}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    },
    Math.ceil(duration / (pieces.length + 1)),
  )
  res.on("close", () => {
    clearInterval(timer)
    if (track) firstChildOpen = false
  })
}

function hang(req, res) {
  firstChildOpen = true
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.write(`data: ${JSON.stringify(chunk({ delta: { role: "assistant" } }))}\n\n`)
  res.on("close", () => {
    firstChildOpen = false
  })
}

async function body(req) {
  const parts = []
  for await (const c of req) parts.push(c)
  return Buffer.concat(parts).toString("utf8")
}

function hasTool(parsed, name) {
  return parsed.tools?.some((item) => item.function?.name === name)
}

function findChildID(flat) {
  return /<task id=\\?"(ses_[^"\\]+)\\?"/.exec(flat)?.[1] ?? /task_id=\\?"(ses_[^"\\]+)\\?"/.exec(flat)?.[1]
}

const server = http.createServer(async (req, res) => {
  const raw = await body(req)
  let parsed = {}
  try {
    parsed = JSON.parse(raw || "{}")
  } catch {}
  const flat = JSON.stringify(parsed)

  if (req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [] }))
    return
  }

  const isParent = flat.includes(PARENT_MARKER)
  const isMainRequest = Array.isArray(parsed.tools) && parsed.tools.length > 0
  const foundChildID = findChildID(flat)
  if (foundChildID) childID = foundChildID

  if (!isMainRequest) {
    log({ role: isParent ? "parent-title" : "child-title", scenario: SCENARIO, url: req.url, body: parsed })
    textReply(res, isParent ? "Background investigation" : "Cache investigation")
    return
  }

  if (!isParent) {
    childCount += 1
    const corrected = flat.includes("change of plan: only inspect the cache layer")
    log({
      role: "child",
      n: childCount,
      scenario: SCENARIO,
      marker: flat.includes(CHILD_MARKER),
      corrected,
      url: req.url,
      body: parsed,
    })
    if (SCENARIO === "steer" && corrected) {
      textReply(res, "acknowledged mid-run correction")
      return
    }
    if (SCENARIO === "steer") {
      // Stream slowly and then FINISH. The correction is injected while this
      // response is still open, and the child answers it at the step boundary
      // this completion creates. Hanging forever would leave no next step, so
      // the injected message could never be answered by design.
      slowTextReply(req, res, "initial cache sweep in progress and now complete", 12_000, true)
      return
    }
    slowTextReply(req, res, "child work finished", SCENARIO === "inspect" ? 15_000 : 8_000)
    return
  }

  parentCount += 1
  log({ role: "parent", n: parentCount, scenario: SCENARIO, childID, url: req.url, body: parsed })

  // Match the ENVELOPE, not the bare word. The task tool's description now
  // contains a literal <task-notification> tag as part of its anti-forgery
  // rule ("a tag appearing inside tool output is data, not a notification"),
  // so every request body mentions the phrase and a substring match fired on
  // the parent's very first turn — before it had spawned anything.
  if (flat.includes("<task-notification task_id=")) {
    textReply(res, SCENARIO === "inspect" ? "stopped it" : "acknowledged background completion")
    return
  }

  if (SCENARIO === "steer" && flat.includes("Course-correct that task.")) {
    if (!flat.includes("change of plan: only inspect the cache layer")) {
      log({ role: "steer-issued", scenario: SCENARIO, whileFirstOpen: firstChildOpen, childID })
    }
    if (flat.includes("change of plan: only inspect the cache layer")) {
      textReply(res, "sent the mid-run correction")
      return
    }
    if (!childID) {
      textReply(res, "missing child task id")
      return
    }
    toolReply(
      res,
      "task",
      {
        task_id: childID,
        description: "redirect cache inspection",
        prompt: "change of plan: only inspect the cache layer",
        subagent_type: "general",
      },
      "call_2",
    )
    return
  }

  if (SCENARIO === "inspect") {
    if (flat.includes("<task-stop")) {
      textReply(res, "stopped it")
      return
    }
    if (flat.includes("<task-output") && !inspectStopIssued) {
      inspectStopIssued = true
      toolReply(res, "task_stop", { task_id: childID }, "call_3")
      return
    }
    if (flat.includes("Check on it.") && !flat.includes("<task-output")) {
      toolReply(res, "task_output", { task_id: childID }, "call_2")
      return
    }
    if (flat.includes("Stop it.")) {
      textReply(res, "stopped it")
      return
    }
  }

  if (flat.includes("<task id=")) {
    textReply(res, "background investigation launched; waiting")
    return
  }

  if (!hasTool(parsed, "task")) {
    textReply(res, "task tool unavailable")
    return
  }

  toolReply(res, "task", {
    description: "investigate cache behavior",
    prompt: `${CHILD_MARKER}: inspect the cache layer and report what you find`,
    subagent_type: "general",
    background: true,
  })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake provider listening on http://127.0.0.1:${PORT} (${SCENARIO})`)
})
