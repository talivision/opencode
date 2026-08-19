// Isolated fake OpenAI-compatible provider used to drive the compiled OpenCode
// binary deterministically. Never contacts a real provider.
//
// Request classification uses protocol markers that only the corresponding
// OpenCode path emits:
//   * reviewer request -> exact verdict-nonce sentence plus goal_verdict tool
//   * worker request   -> exact <active-goal> system block plus goal tool
//   * auxiliary request (for example title generation) -> neither marker
// Do not classify on generic words such as "summary" or "compact": they occur
// in ordinary system prompts and make control requests indistinguishable.
//
// env:
//   PORT                  listen port (default 4599)
//   LOG                   path to append one JSON line per request
//   WORKER_TEXT           worker reply text (default "Lima")
//   WORKER_INPUT/OUTPUT   fake worker usage (default 9000 / 4)
//   REVIEWER_INPUT/OUTPUT fake reviewer usage (default 12000 / 58)
//   REVIEWER_MODE         met | not_met | not_met_history | turns | interrupted | cache-stable | goal-events |
//                         met_tool | not_met_tool | unclaimed | retrieval | permission_blocked | goal_check | invalid |
//                         silent | slow | soak | busy | http500 | ux_goal_window | ux_queued_cancel | overflow_loop
//   REVIEWER_NOT_MET_N    first N reviews return NOT_MET, then MET (default 0)
//   REVIEWER_READ_PATH    controlled absolute path read by permission_blocked
//   CLASSIFIER_SELF_TEST  1 prints positive/control classifier checks and exits
import http from "node:http"
import fs from "node:fs"

const PORT = Number(process.env.PORT ?? 4599)
const LOG = process.env.LOG
const WORKER_TEXT = process.env.WORKER_TEXT ?? "Lima"
const WORKER_USAGE = { input: Number(process.env.WORKER_INPUT ?? 9000), output: Number(process.env.WORKER_OUTPUT ?? 4) }
const REVIEWER_USAGE = {
  input: Number(process.env.REVIEWER_INPUT ?? 12000),
  output: Number(process.env.REVIEWER_OUTPUT ?? 58),
}
const REVIEWER_MODE = process.env.REVIEWER_MODE ?? "not_met"
const REVIEWER_NOT_MET_N = Number(process.env.REVIEWER_NOT_MET_N ?? 0)
const REVIEWER_READ_PATH = process.env.REVIEWER_READ_PATH ?? "/etc/hosts"
const OVERFLOW_LIMIT_CHARS = 60_000
const OVERFLOW_WORKER_TEXT =
  "Continuing careful work while preserving concrete observations, checking assumptions, and recording enough detail for the next turn. ".repeat(
    15,
  )

let reviewCount = 0
let workerCount = 0

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

function textReply(res, text, usage) {
  sse(res, [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { content: text } }),
    chunk({ finish: "stop", usage }),
  ])
}

function toolReply(res, name, args, usage = REVIEWER_USAGE, id = `call_${Date.now()}`) {
  const text = JSON.stringify(args)
  const split = Math.ceil(text.length / 2)
  sse(res, [
    chunk({ delta: { role: "assistant" } }),
    chunk({ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(0, split) } }] } }),
    chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(split) } }] } }),
    chunk({ finish: "tool_calls", usage }),
  ])
}

function slowTextReply(req, res, text, duration, usage = WORKER_USAGE) {
  const pieces = text.split(" ")
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
      res.write(`data: ${JSON.stringify(chunk({ finish: "stop", usage }))}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    },
    Math.ceil(duration / (pieces.length + 1)),
  )
  req.on("close", () => clearInterval(timer))
}

async function body(req) {
  const parts = []
  for await (const c of req) parts.push(c)
  return Buffer.concat(parts).toString("utf8")
}

function hasTool(parsed, name) {
  return parsed.tools?.some((item) => item.function?.name === name)
}

function toolResult(parsed, callID) {
  return parsed.messages?.find((message) => message.role === "tool" && message.tool_call_id === callID)
}

function lastToolResultIs(parsed, name) {
  const last = parsed.messages?.at(-1)
  if (last?.role !== "tool") return false
  return parsed.messages?.some(
    (message) =>
      message.role === "assistant" &&
      message.tool_calls?.some((call) => call.id === last.tool_call_id && call.function?.name === name),
  )
}

export function classifyRequest(parsed) {
  const flat = JSON.stringify(parsed)
  const nonce = /The verdict nonce for this review is ([A-Za-z0-9-]+)\./.exec(flat)?.[1]
  if (nonce && hasTool(parsed, "goal_verdict")) return { role: "reviewer", flat, nonce }
  if (flat.includes("<active-goal>") && hasTool(parsed, "goal")) return { role: "worker", flat }
  return { role: "auxiliary", flat }
}

const server = http.createServer(async (req, res) => {
  const raw = await body(req)
  let parsed = {}
  try {
    parsed = JSON.parse(raw || "{}")
  } catch {}
  if (REVIEWER_MODE === "overflow_loop" && raw.length > OVERFLOW_LIMIT_CHARS) {
    log({ role: "overflow-400", size: raw.length })
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } }))
    return
  }
  const classification = classifyRequest(parsed)
  const flat = classification.flat
  const nonce = classification.nonce
  const isReviewer = classification.role === "reviewer"
  const isWorker = classification.role === "worker"

  if (req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [] }))
    return
  }

  if (REVIEWER_MODE === "overflow_loop" && !isWorker) {
    log({ role: "auxiliary", mode: REVIEWER_MODE, size: raw.length, url: req.url, body: parsed })
    textReply(res, "summarized.", { input: Math.ceil(raw.length / 4), output: 3 })
    return
  }

  if (isReviewer && REVIEWER_MODE === "retrieval") {
    // Retrieval reviewer: build the checklist, pull evidence through
    // goal_transcript, then reject with per-requirement verdicts. The second
    // attempt inherits the persisted checklist and accepts. Every step is
    // chosen from what the request body already contains, so the mode is
    // stateless and survives retries.
    const inherited = flat.includes("Earlier reviewers recorded this checklist")
    const sawChecklist = flat.includes("Checklist recorded")
    const sawTranscript = flat.includes("untrusted-parent-transcript")
    const sawVerdict = flat.includes("Verdict recorded")
    const isFirstStep = !flat.includes('"tool_call_id"') && !flat.includes('"role":"tool"')
    if (isFirstStep) reviewCount += 1
    log({ role: "reviewer", mode: "retrieval", n: reviewCount, nonce, at: Date.now(), url: req.url, body: parsed })
    if (sawVerdict) {
      textReply(res, "Verdict submitted.", REVIEWER_USAGE)
      return
    }
    if (!inherited && !sawChecklist) {
      toolReply(res, "goal_checklist", {
        requirements: [
          { id: "R1", text: "say lima once per turn" },
          { id: "R2", text: "return control at least twice" },
        ],
      })
      return
    }
    if (!inherited && !sawTranscript) {
      toolReply(res, "goal_transcript", { mode: "search", query: "lima" })
      return
    }
    toolReply(
      res,
      "goal_verdict",
      inherited
        ? {
            met: true,
            summary: "both requirements verified against current state",
            unmet: [],
            requirements: [
              { id: "R1", status: "met", evidence: "lima appears in every worker turn" },
              { id: "R2", status: "met", evidence: "control returned twice" },
            ],
          }
        : {
            met: false,
            summary: "control has only been returned once",
            unmet: [{ requirement: "return control at least twice", evidence: "only one worker turn is indexed" }],
            requirements: [
              { id: "R1", status: "met", evidence: "lima found by goal_transcript search" },
              { id: "R2", status: "unmet", evidence: "only one worker turn is indexed" },
            ],
          },
    )
    return
  }

  if (isReviewer && REVIEWER_MODE === "permission_blocked") {
    const read = toolResult(parsed, "call_permission_read")
    const verdict = toolResult(parsed, "call_permission_verdict")
    if (!read && !verdict) reviewCount += 1
    log({ role: "reviewer", mode: REVIEWER_MODE, n: reviewCount, nonce, at: Date.now(), url: req.url, body: parsed })
    if (verdict) {
      textReply(res, "Verdict submitted.", { input: 100, output: 3 })
      return
    }
    if (read) {
      toolReply(
        res,
        "goal_verdict",
        {
          met: true,
          summary: "permission was approved and the controlled external evidence was read",
          unmet: [],
        },
        REVIEWER_USAGE,
        "call_permission_verdict",
      )
      return
    }
    toolReply(res, "read", { filePath: REVIEWER_READ_PATH }, REVIEWER_USAGE, "call_permission_read")
    return
  }

  if (isReviewer && REVIEWER_MODE === "goal_check") {
    const exact = toolResult(parsed, "call_goal_check_exact")
    const refused = toolResult(parsed, "call_goal_check_refused")
    const verdict = toolResult(parsed, "call_goal_check_verdict")
    if (!exact && !refused && !verdict) reviewCount += 1
    log({ role: "reviewer", mode: REVIEWER_MODE, n: reviewCount, nonce, at: Date.now(), url: req.url, body: parsed })
    if (verdict) {
      textReply(res, "Verdict submitted.", { input: 100, output: 3 })
      return
    }
    if (refused) {
      toolReply(
        res,
        "goal_verdict",
        {
          met: true,
          summary:
            "goal_check exact command produced goal-check-ok; the near-miss was refused and named the allowed command",
          unmet: [],
        },
        REVIEWER_USAGE,
        "call_goal_check_verdict",
      )
      return
    }
    if (exact) {
      toolReply(res, "goal_check", { command: "printf goal-check-ok-extra" }, REVIEWER_USAGE, "call_goal_check_refused")
      return
    }
    toolReply(res, "goal_check", { command: "printf goal-check-ok" }, REVIEWER_USAGE, "call_goal_check_exact")
    return
  }

  if (isReviewer) {
    if (flat.includes('"tool_call_id"') || flat.includes('"role":"tool"')) {
      log({ role: "reviewer", n: reviewCount, nonce, at: Date.now(), url: req.url, body: parsed })
      textReply(res, "Verdict submitted.", { input: 100, output: 3 })
      return
    }
    reviewCount += 1
    log({ role: "reviewer", n: reviewCount, nonce, at: Date.now(), url: req.url, body: parsed })
    if (REVIEWER_MODE === "silent") {
      // never respond, never close: exercises the inactivity watchdog
      return
    }
    if (REVIEWER_MODE === "http500") {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "fake provider failure" } }))
      return
    }
    if (REVIEWER_MODE === "busy") {
      // keep emitting text forever: exercises the hard maximum
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write(`data: ${JSON.stringify(chunk({ delta: { role: "assistant" } }))}\n\n`)
      const timer = setInterval(() => {
        res.write(`data: ${JSON.stringify(chunk({ delta: { content: `still checking ${Date.now()}\n` } }))}\n\n`)
      }, 500)
      req.on("close", () => clearInterval(timer))
      return
    }
    if (["slow", "soak", "ux_queued_cancel"].includes(REVIEWER_MODE)) {
      // emit activity every 20s, then finish after 3 bursts: must NOT be killed
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write(`data: ${JSON.stringify(chunk({ delta: { role: "assistant" } }))}\n\n`)
      let n = 0
      const timer = setInterval(() => {
        n += 1
        if (n <= 3) {
          res.write(`data: ${JSON.stringify(chunk({ delta: { content: `checking step ${n}\n` } }))}\n\n`)
          return
        }
        clearInterval(timer)
        if (REVIEWER_MODE === "soak") {
          const args = JSON.stringify({
            met: true,
            summary: "soak review verified the completed objective against current state",
            unmet: [],
          })
          const split = Math.ceil(args.length / 2)
          res.write(
            `data: ${JSON.stringify(
              chunk({
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_soak_verdict",
                      type: "function",
                      function: { name: "goal_verdict", arguments: "" },
                    },
                  ],
                },
              }),
            )}\n\n`,
          )
          res.write(
            `data: ${JSON.stringify(
              chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, split) } }] } }),
            )}\n\n`,
          )
          res.write(
            `data: ${JSON.stringify(
              chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] } }),
            )}\n\n`,
          )
          res.write(`data: ${JSON.stringify(chunk({ finish: "tool_calls", usage: REVIEWER_USAGE }))}\n\n`)
          res.write("data: [DONE]\n\n")
          res.end()
          return
        }
        res.write(
          `data: ${JSON.stringify(chunk({ delta: { content: `VERDICT: MET ${nonce} slow but verified` } }))}\n\n`,
        )
        res.write(`data: ${JSON.stringify(chunk({ finish: "stop", usage: REVIEWER_USAGE }))}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      }, 20_000)
      req.on("close", () => clearInterval(timer))
      return
    }
    if (REVIEWER_MODE === "invalid") {
      textReply(res, "I think it is fine.\nVERDICT: MET deadbeefdead no matching nonce", REVIEWER_USAGE)
      return
    }
    if (REVIEWER_MODE === "not_met_history" && reviewCount <= 2) {
      const reason =
        reviewCount === 1
          ? "alpha evidence is missing from the authoritative state"
          : "beta regression remains unresolved after the latest worker turn"
      textReply(res, `Checked the transcript and current state.\nVERDICT: NOT_MET ${nonce} ${reason}`, REVIEWER_USAGE)
      return
    }
    const met =
      ["met", "met_tool", "not_met_history", "turns", "interrupted", "cache-stable", "goal-events"].includes(
        REVIEWER_MODE,
      ) || reviewCount > REVIEWER_NOT_MET_N
    if (["met_tool", "not_met_tool", "unclaimed"].includes(REVIEWER_MODE)) {
      const verdictArguments = met
        ? '{"met": true, "summary": "tool verdict: objective verified against current state", "unmet": []}'
        : '{"met": false, "summary": "tool verdict: not yet met", "unmet": [{"requirement": "say lima twice", "evidence": "only one lima found in the transcript"}]}'
      const split = Math.ceil(verdictArguments.length / 2)
      sse(res, [
        chunk({ delta: { role: "assistant" } }),
        chunk({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_verdict_${reviewCount}`,
                type: "function",
                function: { name: "goal_verdict", arguments: "" },
              },
            ],
          },
        }),
        chunk({
          delta: { tool_calls: [{ index: 0, function: { arguments: verdictArguments.slice(0, split) } }] },
        }),
        chunk({
          delta: { tool_calls: [{ index: 0, function: { arguments: verdictArguments.slice(split) } }] },
        }),
        chunk({ finish: "tool_calls", usage: REVIEWER_USAGE }),
      ])
      return
    }
    const verdict = met ? "MET" : "NOT_MET"
    textReply(
      res,
      `Checked the transcript and current state.\nVERDICT: ${verdict} ${nonce} review ${reviewCount} verdict ${verdict}`,
      REVIEWER_USAGE,
    )
    return
  }

  if (!isWorker) {
    log({ role: "auxiliary", mode: REVIEWER_MODE, url: req.url, body: parsed })
    textReply(res, "Harness auxiliary request", { input: 10, output: 3 })
    return
  }

  workerCount += 1
  log({
    role: "worker",
    mode: REVIEWER_MODE,
    n: workerCount,
    ...(REVIEWER_MODE === "cache-stable" ? { turn: workerCount === 1 ? 1 : 2 } : {}),
    at: Date.now(),
    url: req.url,
    body: parsed,
  })
  if (REVIEWER_MODE === "ux_goal_window") {
    // WORKER_TEXT override lets wrap/render checks feed arbitrary long text.
    textReply(
      res,
      WORKER_TEXT === "Lima" ? "Continuing careful work without claiming completion." : WORKER_TEXT,
      WORKER_USAGE,
    )
    return
  }
  if (REVIEWER_MODE === "overflow_loop") {
    textReply(res, OVERFLOW_WORKER_TEXT, {
      input: Math.ceil(raw.length / 4),
      output: Math.ceil(OVERFLOW_WORKER_TEXT.length / 4),
    })
    return
  }
  if (REVIEWER_MODE === "soak" && workerCount <= 6) {
    textReply(res, `Soak worker turn ${workerCount} ended without claiming completion.`, WORKER_USAGE)
    return
  }
  if (REVIEWER_MODE === "ux_search") {
    // Two searchable assistant texts, then filler with none of the scenario's
    // search terms so late reminder-driven turns cannot shift the match count.
    const texts = ["the amber zebra crossed quietly", "a xylophone hummed near the harbor"]
    textReply(res, texts[workerCount - 1] ?? "background hum continues, no keywords", WORKER_USAGE)
    return
  }
  if (lastToolResultIs(parsed, "goal")) {
    textReply(res, "Claim submitted; awaiting review.", WORKER_USAGE)
    return
  }
  if (REVIEWER_MODE === "cache-stable" && workerCount === 1) {
    // End one goal turn before any review. The continuation must carry the
    // interruption in its user message without perturbing the cached system
    // message on the next worker turn.
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "GOAL_HARNESS_CACHE_TURN_BOUNDARY" } }))
    return
  }
  if (REVIEWER_MODE === "interrupted" && workerCount === 1) {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "GOAL_HARNESS_PROVIDER_400" } }))
    return
  }
  if (REVIEWER_MODE === "interrupted" && workerCount === 2) {
    // A normal, finite stream with enough duration for drive.sh to snapshot the
    // durable interrupted record before the clean turn clears it.
    slowTextReply(req, res, "worker resumed after the provider error", 4_000)
    return
  }
  if (REVIEWER_MODE === "unclaimed" && workerCount === 1) {
    textReply(res, "First turn ended without a completion claim.", WORKER_USAGE)
    return
  }
  if (
    (REVIEWER_MODE === "turns" && workerCount <= 2) ||
    (REVIEWER_MODE === "cache-stable" && workerCount >= 2 && workerCount <= 3)
  ) {
    toolReply(
      res,
      "glob",
      {
        pattern:
          workerCount === 1 || (REVIEWER_MODE === "cache-stable" && workerCount === 2)
            ? "script/goal-harness/*"
            : "script/subagent-harness/*",
      },
      WORKER_USAGE,
      `call_goal_glob_${workerCount}`,
    )
    return
  }
  toolReply(
    res,
    "goal",
    { status: "complete", reason: `${WORKER_TEXT}: current-state evidence gathered by worker turn ${workerCount}` },
    WORKER_USAGE,
    `call_goal_complete_${workerCount}`,
  )
})

if (process.env.CLASSIFIER_SELF_TEST === "1") {
  const cases = [
    {
      name: "positive reviewer",
      expected: "reviewer",
      body: {
        messages: [{ role: "system", content: "The verdict nonce for this review is nonce-positive-1." }],
        tools: [{ type: "function", function: { name: "goal_verdict" } }],
      },
    },
    {
      name: "positive worker",
      expected: "worker",
      body: {
        messages: [{ role: "system", content: "<active-goal>\nObjective: probe\n</active-goal>" }],
        tools: [{ type: "function", function: { name: "goal" } }],
      },
    },
    {
      name: "generic-word control",
      expected: "auxiliary",
      body: {
        messages: [{ role: "system", content: "Please summarize compact goal review history." }],
        tools: [{ type: "function", function: { name: "goal" } }],
      },
    },
  ]
  const failed = cases.filter((item) => {
    const actual = classifyRequest(item.body).role
    console.log(`${actual === item.expected ? "ok" : "not ok"} ${item.name}: ${actual}`)
    return actual !== item.expected
  })
  const goalFollowup = {
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "call_goal", type: "function", function: { name: "goal", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_goal", content: "Completion is pending independent review." },
    ],
  }
  const followsGoal = lastToolResultIs(goalFollowup, "goal")
  console.log(`${followsGoal ? "ok" : "not ok"} goal tool-result follow-up: ${followsGoal}`)
  process.exit(failed.length || !followsGoal ? 1 : 0)
} else {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`fake provider listening on http://127.0.0.1:${PORT}`)
  })
}
