// Isolated fake OpenAI-compatible provider used to drive the compiled OpenCode
// binary deterministically. Never contacts a real provider.
//
// Behaviour is chosen from the request body:
//   * reviewer request  -> body contains "verdict nonce for this review is <nonce>"
//   * worker request    -> everything else
//
// env:
//   PORT                  listen port (default 4599)
//   LOG                   path to append one JSON line per request
//   WORKER_TEXT           worker reply text (default "Lima")
//   WORKER_INPUT/OUTPUT   fake worker usage (default 9000 / 4)
//   REVIEWER_INPUT/OUTPUT fake reviewer usage (default 12000 / 58)
//   REVIEWER_MODE         met | not_met | met_tool | not_met_tool | invalid | silent | slow | busy | http500
//   REVIEWER_NOT_MET_N    first N reviews return NOT_MET, then MET (default 0)
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

async function body(req) {
  const parts = []
  for await (const c of req) parts.push(c)
  return Buffer.concat(parts).toString("utf8")
}

const server = http.createServer(async (req, res) => {
  const raw = await body(req)
  let parsed = {}
  try {
    parsed = JSON.parse(raw || "{}")
  } catch {}
  const flat = JSON.stringify(parsed)
  const nonce = /verdict nonce for this review is ([A-Za-z0-9-]+)/i.exec(flat)?.[1]
  const isReviewer = Boolean(nonce)

  if (req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [] }))
    return
  }

  if (isReviewer) {
    if (flat.includes("\"tool_call_id\"") || flat.includes("\"role\":\"tool\"")) {
      log({ role: "reviewer", n: reviewCount, nonce, url: req.url, body: parsed })
      textReply(res, "Verdict submitted.", { input: 100, output: 3 })
      return
    }
    reviewCount += 1
    log({ role: "reviewer", n: reviewCount, nonce, url: req.url, body: parsed })
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
    if (REVIEWER_MODE === "slow") {
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
        res.write(`data: ${JSON.stringify(chunk({ delta: { content: `VERDICT: MET ${nonce} slow but verified` } }))}\n\n`)
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
    const met = REVIEWER_MODE === "met" || REVIEWER_MODE === "met_tool" || reviewCount > REVIEWER_NOT_MET_N
    if (REVIEWER_MODE === "met_tool" || REVIEWER_MODE === "not_met_tool") {
      const verdictArguments = met
        ? "{\"met\": true, \"summary\": \"tool verdict: objective verified against current state\", \"unmet\": []}"
        : "{\"met\": false, \"summary\": \"tool verdict: not yet met\", \"unmet\": [{\"requirement\": \"say lima twice\", \"evidence\": \"only one lima found in the transcript\"}]}"
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

  workerCount += 1
  log({ role: "worker", n: workerCount, url: req.url, body: parsed })
  textReply(res, WORKER_TEXT, WORKER_USAGE)
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake provider listening on http://127.0.0.1:${PORT}`)
})
