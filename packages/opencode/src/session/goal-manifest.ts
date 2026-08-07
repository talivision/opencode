export * as GoalManifest from "./goal-manifest"

import type { SessionV1 } from "@opencode-ai/core/v1/session"

// Pure, server-free view over a parent worker transcript.
//
// The goal reviewer used to receive the entire parent transcript inlined in its
// first user message, tail-capped at 60_000 chars. That was slow, expensive,
// and lossy at exactly the wrong end: the tail slice discarded the HEAD, where
// the early requirements and the evidence for them live.
//
// Instead the reviewer is seeded with an INDEX — one line per message and one
// line per tool call, carrying ids, names, targets and status but never tool
// output — and pulls the content it actually needs through the goal_transcript
// tool. Everything in this module is a pure function over SessionV1.WithParts[]
// so it can be unit-tested without a session server.

/** Upper bound on index entries before the middle is elided. */
export const MAX_ENTRIES = 400
/**
 * Character budget for the index body — the binding constraint. 400 entries of
 * a real session run to ~46_000 chars (~11k tokens), which is no cheaper than
 * the 60_000-char transcript it replaces, so the body is shrunk head-and-tail
 * until it fits ~2.5k tokens. Search recovers whatever falls in the hole.
 */
export const MAX_BODY_CHARS = 7_000
/** Per-message one-line summary budget. */
export const SUMMARY_CHARS = 100
/** Per-tool-call target descriptor budget. */
export const TARGET_CHARS = 80
/** Aggregate lists (files touched, commands run) are capped for the same reason. */
export const MAX_AGGREGATE_ITEMS = 20

/** Default and hard ceiling for a single goal_transcript retrieval. */
export const DEFAULT_MAX_CHARS = 20_000
export const HARD_MAX_CHARS = 40_000
/** search mode caps: matches, chars per match line, total chars. */
export const SEARCH_MAX_MATCHES = 40
export const SEARCH_LINE_CHARS = 200
export const SEARCH_MAX_CHARS = 8_000

// The goal-review bookkeeping part is the goal loop talking to itself. It was
// already excluded from the old inlined transcript; keep it out of both the
// manifest and retrieval so a reviewer cannot read a previous reviewer's
// verdict and mistake it for evidence. Prior rejections still reach the worker
// through review.history.
const EXCLUDED_TOOLS = new Set(["goal-review"])

const TARGET_KEYS = [
  "filePath",
  "path",
  "file",
  "command",
  "pattern",
  "query",
  "url",
  "subagent_type",
  "description",
  "name",
  "prompt",
]
const FILE_KEYS = ["filePath", "path", "file"]

export type Options = {
  maxEntries?: number
  maxBodyChars?: number
  summaryChars?: number
}

export type Stats = {
  messages: number
  toolCalls: number
  entries: number
  elided: number
  files: string[]
  commands: string[]
}

export type Manifest = Stats & { text: string }

export function oneLine(value: string, limit: number) {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 3))}...`
}

function timestamp(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "unknown-time"
  return new Date(value).toISOString().slice(0, 19)
}

function input(part: SessionV1.ToolPart) {
  const value = part.state.input
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

export function describeTarget(part: SessionV1.ToolPart) {
  const args = input(part)
  if (args) {
    for (const key of TARGET_KEYS) {
      const value = args[key]
      if (typeof value === "string" && value.trim()) return oneLine(value, TARGET_CHARS)
      if (typeof value === "number" && Number.isFinite(value)) return String(value)
    }
  }
  const title = part.state.status === "running" || part.state.status === "completed" ? part.state.title : undefined
  return title ? oneLine(title, TARGET_CHARS) : ""
}

/** Full result text of a tool call, whatever state it ended in. */
export function toolResult(part: SessionV1.ToolPart) {
  const state = part.state
  if (state.status === "completed") return state.output
  if (state.status === "error") return state.error
  if (state.status === "running") return state.title ?? "(running)"
  return "(pending)"
}

function visibleTools(message: SessionV1.WithParts) {
  return message.parts.filter(
    (part): part is SessionV1.ToolPart => part.type === "tool" && !EXCLUDED_TOOLS.has(part.tool),
  )
}

function summarize(message: SessionV1.WithParts, limit: number) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim()
  if (text) return oneLine(text, limit)
  const tools = visibleTools(message)
  if (tools.length) return `(${tools.length} tool call${tools.length === 1 ? "" : "s"}, no text)`
  return "(no text)"
}

function role(message: SessionV1.WithParts) {
  return message.info.role === "assistant" ? "assistant" : "user"
}

/**
 * Build the reviewer-facing index. One entry per message plus one per tool
 * call; the middle is elided past `maxEntries` because search recovers
 * anything that falls in the hole.
 */
export function build(messages: SessionV1.WithParts[], options?: Options): Manifest {
  const maxEntries = Math.max(2, options?.maxEntries ?? MAX_ENTRIES)
  const maxBodyChars = Math.max(500, options?.maxBodyChars ?? MAX_BODY_CHARS)
  const summaryChars = Math.max(16, options?.summaryChars ?? SUMMARY_CHARS)

  const lines: string[] = []
  const files: string[] = []
  const commands: string[] = []
  const seenFiles = new Set<string>()
  const seenCommands = new Set<string>()
  let users = 0
  let assistants = 0
  let toolCalls = 0

  for (const message of messages) {
    if (message.info.role === "assistant") assistants += 1
    else users += 1
    lines.push(
      `${message.info.id} ${role(message)} ${timestamp(message.info.time.created)} ${summarize(message, summaryChars)}`,
    )
    for (const part of visibleTools(message)) {
      toolCalls += 1
      lines.push(`  ${part.callID} ${part.tool} [${part.state.status}] ${describeTarget(part)}`.trimEnd())
      const args = input(part)
      if (!args) continue
      for (const key of FILE_KEYS) {
        const value = args[key]
        if (typeof value !== "string" || !value.trim()) continue
        if (seenFiles.has(value)) break
        seenFiles.add(value)
        files.push(value)
        break
      }
      const command = args["command"]
      if (typeof command === "string" && command.trim() && !seenCommands.has(command)) {
        seenCommands.add(command)
        commands.push(oneLine(command, TARGET_CHARS))
      }
    }
  }

  const entries = lines.length
  const keep = fit(lines, maxEntries, maxBodyChars)
  const elided = entries - keep
  const head = Math.ceil(keep / 2)
  const body = elided
    ? [
        ...lines.slice(0, head),
        `... [${elided} index entries elided from the middle — recover them with goal_transcript mode=search] ...`,
        ...lines.slice(entries - (keep - head)),
      ]
    : lines

  const text = [
    `Messages: ${messages.length} (user ${users}, assistant ${assistants}). Tool calls: ${toolCalls}. Index entries: ${entries}${
      elided ? ` (${elided} elided)` : ""
    }.`,
    `Files touched (${files.length}): ${list(files)}`,
    `Commands run (${commands.length}): ${list(commands)}`,
    "",
    'Message lines are "<message-id> <role> <utc-time> <summary>".',
    'Tool lines are "  <call-id> <tool> [<status>] <target>". Tool OUTPUT is not in this index.',
    "",
    ...body,
  ].join("\n")

  return { text, messages: messages.length, toolCalls, entries, elided, files, commands }
}

/**
 * How many entries survive: at most `maxEntries`, and few enough that the
 * head-plus-tail body fits `maxBodyChars`. Shrinks proportionally so a very
 * long session does not walk down one entry at a time.
 */
function fit(lines: string[], maxEntries: number, maxBodyChars: number) {
  const size = (count: number) => {
    const head = Math.ceil(count / 2)
    let total = 0
    for (let i = 0; i < head; i++) total += lines[i]!.length + 1
    for (let i = lines.length - (count - head); i < lines.length; i++) total += lines[i]!.length + 1
    return total
  }
  let keep = Math.min(lines.length, maxEntries)
  while (keep > 2) {
    const total = size(keep)
    if (total <= maxBodyChars) break
    keep = Math.max(2, Math.min(keep - 1, Math.floor(keep * (maxBodyChars / total))))
  }
  return keep
}

function list(values: string[]) {
  if (!values.length) return "none"
  const shown = values.slice(0, MAX_AGGREGATE_ITEMS).map((value) => oneLine(value, TARGET_CHARS))
  if (values.length <= MAX_AGGREGATE_ITEMS) return shown.join(", ")
  return `${shown.join(", ")}, +${values.length - MAX_AGGREGATE_ITEMS} more`
}

function renderMessage(message: SessionV1.WithParts) {
  const parts = message.parts.flatMap((part) => {
    if (part.type === "text") return [part.text]
    if (part.type !== "tool" || EXCLUDED_TOOLS.has(part.tool)) return []
    return [
      `[tool ${part.tool} ${part.state.status} call=${part.callID}] input=${JSON.stringify(part.state.input)} result=${toolResult(part)}`,
    ]
  })
  if (!parts.length) return
  return `${message.info.id} ${role(message).toUpperCase()} ${timestamp(message.info.time.created)}\n${parts.join("\n")}`
}

export function clampChars(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_CHARS
  return Math.min(HARD_MAX_CHARS, Math.max(500, Math.floor(value)))
}

export type Retrieval = { ok: true; text: string; truncated: boolean } | { ok: false; error: string }

/**
 * Contiguous message range by message id. Unlike the old tail slice this keeps
 * the HEAD of whatever the reviewer asked for: the model chose the window, so
 * dropping its end is the honest truncation.
 */
export function slice(
  messages: SessionV1.WithParts[],
  params: { startID?: string; endID?: string; maxChars?: number },
): Retrieval {
  const limit = clampChars(params.maxChars)
  const startIndex = params.startID ? messages.findIndex((m) => m.info.id === params.startID) : 0
  if (startIndex === -1) return { ok: false, error: `No message with id ${params.startID} exists in this transcript.` }
  const endIndex = params.endID ? messages.findIndex((m) => m.info.id === params.endID) : messages.length - 1
  if (endIndex === -1) return { ok: false, error: `No message with id ${params.endID} exists in this transcript.` }
  if (endIndex < startIndex) return { ok: false, error: "end_id occurs before start_id in this transcript." }
  const rendered = messages
    .slice(startIndex, endIndex + 1)
    .map(renderMessage)
    .filter((value): value is string => value !== undefined)
  if (!rendered.length)
    return { ok: true, text: "(the requested range contains no text or tool content)", truncated: false }
  const text = rendered.join("\n\n")
  if (text.length <= limit) return { ok: true, text, truncated: false }
  return {
    ok: true,
    text: `${text.slice(0, limit)}\n[truncated at ${limit} chars — narrow the range or use mode=tool_call]`,
    truncated: true,
  }
}

/** One tool call in full: its input and its result. */
export function toolCall(messages: SessionV1.WithParts[], params: { callID: string; maxChars?: number }): Retrieval {
  const limit = clampChars(params.maxChars)
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.callID !== params.callID) continue
      if (EXCLUDED_TOOLS.has(part.tool)) {
        return { ok: false, error: `Call ${params.callID} is goal-loop bookkeeping and is not retrievable.` }
      }
      const head = [
        `message: ${message.info.id}`,
        `tool: ${part.tool}`,
        `status: ${part.state.status}`,
        `input: ${JSON.stringify(part.state.input)}`,
        "result:",
      ].join("\n")
      const result = toolResult(part)
      const room = Math.max(200, limit - head.length - 1)
      if (result.length <= room) return { ok: true, text: `${head}\n${result}`, truncated: false }
      return {
        ok: true,
        text: `${head}\n${result.slice(0, room)}\n[truncated at ${room} chars of result — raise max_chars or search within it]`,
        truncated: true,
      }
    }
  }
  return { ok: false, error: `No tool call with id ${params.callID} exists in this transcript.` }
}

function matcher(query: string) {
  const match = /^\/(.*)\/([a-z]*)$/s.exec(query.trim())
  if (match && match[1]) {
    try {
      const regex = new RegExp(match[1], match[2]?.replace(/[^gimsuy]/g, "").replace(/g/g, "") ?? "")
      return (line: string) => regex.test(line)
    } catch {
      // fall through to a literal search rather than failing the retrieval
    }
  }
  return (line: string) => line.includes(query)
}

/**
 * Grep the transcript. Capped hard: at most SEARCH_MAX_MATCHES hits, one line
 * of context each, SEARCH_MAX_CHARS total — a search must never be a way to
 * smuggle the whole transcript back into context.
 */
export function search(messages: SessionV1.WithParts[], params: { query: string }): Retrieval {
  const query = params.query.trim()
  if (!query) return { ok: false, error: "query must be a non-empty literal substring or /regex/." }
  const test = matcher(query)
  const hits: string[] = []
  let total = 0
  let truncated = false
  let scanned = 0

  outer: for (const message of messages) {
    for (const part of message.parts) {
      let lines: string[]
      let tag: string
      if (part.type === "text") {
        lines = part.text.split("\n")
        tag = message.info.id
      } else if (part.type === "tool" && !EXCLUDED_TOOLS.has(part.tool)) {
        lines = [`input=${JSON.stringify(part.state.input)}`, ...toolResult(part).split("\n")]
        tag = `${message.info.id} ${part.callID} ${part.tool}`
      } else continue
      for (const line of lines) {
        scanned += 1
        if (!test(line)) continue
        const rendered = `${tag}: ${oneLine(line, SEARCH_LINE_CHARS)}`
        if (hits.length >= SEARCH_MAX_MATCHES || total + rendered.length > SEARCH_MAX_CHARS) {
          truncated = true
          break outer
        }
        hits.push(rendered)
        total += rendered.length + 1
      }
    }
  }

  if (!hits.length) {
    return { ok: true, text: `No match for ${query} in ${scanned} transcript lines.`, truncated: false }
  }
  return {
    ok: true,
    text: [
      `${hits.length} match${hits.length === 1 ? "" : "es"}${truncated ? " (capped — narrow the query)" : ""}:`,
      ...hits,
    ].join("\n"),
    truncated,
  }
}
