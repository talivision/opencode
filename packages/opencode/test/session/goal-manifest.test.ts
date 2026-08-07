import { describe, expect, it } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { GoalManifest } from "@/session/goal-manifest"

// Pure fixtures: GoalManifest is a function over SessionV1.WithParts[] and must
// stay unit-testable without a session server.
const BASE = 1_700_000_000_000

function text(id: string, value: string): SessionV1.TextPart {
  return { id, sessionID: "ses_1", messageID: "msg", type: "text", text: value } as unknown as SessionV1.TextPart
}

function call(input: {
  callID: string
  tool: string
  args: Record<string, unknown>
  output?: string
  status?: "completed" | "error" | "running" | "pending"
}): SessionV1.ToolPart {
  const status = input.status ?? "completed"
  const state =
    status === "completed"
      ? {
          status,
          input: input.args,
          output: input.output ?? "",
          title: input.tool,
          metadata: {},
          time: { start: BASE, end: BASE + 1 },
        }
      : status === "error"
        ? { status, input: input.args, error: input.output ?? "boom", time: { start: BASE, end: BASE + 1 } }
        : status === "running"
          ? { status, input: input.args, title: input.tool, time: { start: BASE } }
          : { status, input: input.args, raw: "" }
  return {
    id: `prt_${input.callID}`,
    sessionID: "ses_1",
    messageID: "msg",
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state,
  } as unknown as SessionV1.ToolPart
}

function message(input: {
  id: string
  role: "user" | "assistant"
  parts: SessionV1.Part[]
  created?: number
}): SessionV1.WithParts {
  return {
    info: {
      id: input.id,
      sessionID: "ses_1",
      role: input.role,
      time: { created: input.created ?? BASE },
    },
    parts: input.parts,
  } as unknown as SessionV1.WithParts
}

const transcript: SessionV1.WithParts[] = [
  message({ id: "msg_1", role: "user", parts: [text("prt_a", "build the exporter and cover it with tests")] }),
  message({
    id: "msg_2",
    role: "assistant",
    parts: [
      text("prt_b", "Reading the current exporter."),
      call({
        callID: "call_read",
        tool: "read",
        args: { filePath: "src/exporter.ts" },
        output: "SECRET_EXPORTER_BODY line one\nSECRET_EXPORTER_BODY line two",
      }),
      call({
        callID: "call_bash",
        tool: "bash",
        args: { command: "bun test src/exporter.test.ts" },
        output: "3 pass 0 fail",
      }),
    ],
  }),
  message({
    id: "msg_3",
    role: "assistant",
    parts: [call({ callID: "call_write", tool: "write", args: { filePath: "src/exporter.ts" }, output: "written" })],
  }),
]

describe("GoalManifest.build", () => {
  it("indexes message ids, roles, summaries, and tool calls but never tool output", () => {
    const manifest = GoalManifest.build(transcript)

    expect(manifest.text).toContain("msg_1 user")
    expect(manifest.text).toContain("build the exporter and cover it with tests")
    expect(manifest.text).toContain("call_read read [completed] src/exporter.ts")
    expect(manifest.text).toContain("call_bash bash [completed] bun test src/exporter.test.ts")
    // The whole point of the index: outputs are not in it.
    expect(manifest.text).not.toContain("SECRET_EXPORTER_BODY")
    expect(manifest.text).not.toContain("3 pass 0 fail")
    expect(manifest.messages).toBe(3)
    expect(manifest.toolCalls).toBe(3)
  })

  it("aggregates files touched and commands run", () => {
    const manifest = GoalManifest.build(transcript)
    expect(manifest.files).toEqual(["src/exporter.ts"])
    expect(manifest.commands).toEqual(["bun test src/exporter.test.ts"])
    expect(manifest.text).toContain("Files touched (1): src/exporter.ts")
    expect(manifest.text).toContain("Commands run (1): bun test src/exporter.test.ts")
  })

  it("excludes goal-review bookkeeping parts", () => {
    const manifest = GoalManifest.build([
      message({
        id: "msg_x",
        role: "assistant",
        parts: [call({ callID: "call_review", tool: "goal-review", args: { attempt: 1 }, output: "rejected" })],
      }),
    ])
    expect(manifest.toolCalls).toBe(0)
    expect(manifest.text).not.toContain("call_review")
  })

  it("elides the middle, never the head, past maxEntries", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      message({ id: `msg_${i}`, role: "user", parts: [text(`prt_${i}`, `line ${i}`)] }),
    )
    const manifest = GoalManifest.build(many, { maxEntries: 10 })
    expect(manifest.entries).toBe(40)
    expect(manifest.elided).toBe(30)
    // Head survives — the old tail-only 60k slice is exactly what this replaces.
    expect(manifest.text).toContain("msg_0 user")
    expect(manifest.text).toContain("msg_39 user")
    expect(manifest.text).not.toContain("msg_20 user")
    expect(manifest.text).toContain("30 index entries elided from the middle")
  })

  it("stays small for a long session", () => {
    const long = Array.from({ length: 300 }, (_, i) =>
      message({
        id: `msg_${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [
          text(`prt_t${i}`, `step ${i}: ${"considered the requirement in detail ".repeat(6)}`),
          call({
            callID: `call_${i}`,
            tool: "read",
            args: { filePath: `packages/opencode/src/module-${i}/index.ts` },
            output: "x".repeat(5_000),
          }),
        ],
      }),
    )
    const manifest = GoalManifest.build(long)
    expect(manifest.entries).toBe(600)
    expect(manifest.elided).toBeGreaterThan(0)
    // The old design inlined up to 60_000 chars of transcript, tail-only. The
    // index must cost a small fraction of that — ~2.5k tokens, not ~15k.
    expect(manifest.text.length).toBeLessThan(11_000)
    expect(manifest.text).not.toContain("xxxxxxxxxx")
    // Both ends survive whatever the elision does.
    expect(manifest.text).toContain("msg_0 user")
    expect(manifest.text).toContain("msg_299 assistant")
  })
})

describe("GoalManifest.slice", () => {
  it("returns a message range and keeps the head when truncating", () => {
    const result = GoalManifest.slice(transcript, { startID: "msg_2", endID: "msg_2" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain("SECRET_EXPORTER_BODY")
    expect(result.text).not.toContain("build the exporter")
    expect(result.truncated).toBe(false)
  })

  it("clamps max_chars to the server ceiling regardless of what the model asks", () => {
    const big = [
      message({
        id: "msg_big",
        role: "assistant",
        parts: [call({ callID: "call_big", tool: "read", args: { filePath: "big" }, output: "y".repeat(200_000) })],
      }),
    ]
    const asked = GoalManifest.slice(big, { maxChars: 10_000_000 })
    expect(asked.ok).toBe(true)
    if (!asked.ok) return
    expect(asked.truncated).toBe(true)
    expect(asked.text.length).toBeLessThan(GoalManifest.HARD_MAX_CHARS + 200)

    const defaulted = GoalManifest.slice(big, {})
    expect(defaulted.ok && defaulted.text.length).toBeLessThan(GoalManifest.DEFAULT_MAX_CHARS + 200)
  })

  it("rejects unknown and inverted ids", () => {
    expect(GoalManifest.slice(transcript, { startID: "msg_nope" })).toMatchObject({ ok: false })
    expect(GoalManifest.slice(transcript, { startID: "msg_3", endID: "msg_1" })).toMatchObject({ ok: false })
  })
})

describe("GoalManifest.toolCall", () => {
  it("returns one call's full input and result", () => {
    const result = GoalManifest.toolCall(transcript, { callID: "call_bash" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain("tool: bash")
    expect(result.text).toContain("bun test src/exporter.test.ts")
    expect(result.text).toContain("3 pass 0 fail")
  })

  it("reports an unknown call id instead of guessing", () => {
    expect(GoalManifest.toolCall(transcript, { callID: "call_missing" })).toMatchObject({ ok: false })
  })
})

describe("GoalManifest.search", () => {
  it("finds literal matches with one line of context and tags them with ids", () => {
    const result = GoalManifest.search(transcript, { query: "SECRET_EXPORTER_BODY line two" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain("msg_2 call_read read:")
    expect(result.text).toContain("line two")
    expect(result.text).not.toContain("line one")
  })

  it("supports /regex/ and reports no match without dumping the transcript", () => {
    const hit = GoalManifest.search(transcript, { query: "/3 +pass/" })
    expect(hit.ok && hit.text).toContain("3 pass 0 fail")
    const miss = GoalManifest.search(transcript, { query: "definitely-not-present" })
    expect(miss.ok && miss.text).toContain("No match for definitely-not-present")
  })

  it("caps matches and total size so search cannot smuggle the transcript back", () => {
    const noisy = [
      message({
        id: "msg_noise",
        role: "assistant",
        parts: [text("prt_noise", Array.from({ length: 500 }, (_, i) => `needle ${i} ${"z".repeat(400)}`).join("\n"))],
      }),
    ]
    const result = GoalManifest.search(noisy, { query: "needle" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(GoalManifest.SEARCH_MAX_CHARS + 200)
    expect(result.text.split("\n").length - 1).toBeLessThanOrEqual(GoalManifest.SEARCH_MAX_MATCHES)
  })
})
