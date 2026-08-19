// Reproduces the compaction death loop reported from real usage:
//
//   model window (real):        260_000 tokens (provider-enforced)
//   configured `limit.context`: 256_000 tokens (what all local arithmetic uses)
//   requested-output knob:       32_678 tokens (dynamic output window ceiling)
//
// With those numbers usable() = 256_000 - (16_384 floor + 5_120 safety) =
// 234_496, so auto-compaction triggers at ~234k measured tokens. But the
// compaction request itself carries the ENTIRE serialized head (selection only
// budgets the preserved tail, never the summarized head) plus a max_tokens
// that is floored at 16_384. Once the transcript is big enough that the main
// request overflowed the provider window, the compaction request is the same
// size or bigger, overflows too, is never retried with a smaller selection,
// and the session errors "too large to compact" forever.
//
// The tests below assert the DESIRED invariant -- the compaction request must
// fit the model window by the code's own arithmetic -- so they are RED against
// the current implementation and turn green with the fix (selection shrinking
// / chunked summarization).
import { afterEach, describe, expect, mock } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer, Schema, Stream } from "effect"
import { Config } from "@/config/config"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "@/util/token"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Provider } from "@/provider/provider"
import { SessionProcessor } from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { outputFloor, requestedOutput, safety } from "@/session/output-window"
import { usable } from "@/session/overflow"
import { LLMEvent, Usage } from "@opencode-ai/llm"

// ---------------------------------------------------------------------------
// User-reported configuration
// ---------------------------------------------------------------------------

/** What the user configured as `limit: 256000` (context) for the model. */
const CONFIGURED_CONTEXT = 256_000
/** The fork's dynamic output window / requested-output knob. */
const REQUESTED_OUTPUT = 32_678

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function createModel(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: CONFIGURED_CONTEXT,
      input: undefined,
      output: REQUESTED_OUTPUT,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const baseConfig = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info

afterEach(() => {
  mock.restore()
  captured.length = 0
  chunkCaptured.length = 0
  chunkSummary = 0
})

// ---------------------------------------------------------------------------
// Harness (mirrors compaction.test.ts): fake processor that reports the
// provider's verdict. `result: "compact"` is exactly what SessionProcessor
// returns when the compaction request itself dies on a ContextOverflowError
// (processor.ts halt() -> ctx.needsCompaction = true -> "compact").
// ---------------------------------------------------------------------------

const captured: LLM.StreamInput[] = []

function fakeProcessor(
  input: Parameters<SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")((streamInput) => {
      captured.push(streamInput)
      return Effect.succeed(result)
    }),
  } satisfies SessionProcessor.Handle
}

function processorLayer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessor.Service,
    SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fakeProcessor(input, result))),
    }),
  )
}

function processorSequenceLayer(results: Array<"continue" | "compact">) {
  return Layer.succeed(
    SessionProcessor.Service,
    SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) =>
        Effect.succeed(fakeProcessor(input, results.shift() ?? "continue")),
      ),
    }),
  )
}

const summaryStub = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const compactionTestNode = LayerNode.group([
  SessionCompaction.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])

function env(result: "continue" | "compact") {
  return AppNodeBuilder.build(compactionTestNode, [
    [Provider.node, ProviderTest.fake({ model: createModel() }).layer],
    [SessionProcessor.node, processorLayer(result)],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, outputTokenMax: REQUESTED_OUTPUT })],
    [SessionSummary.node, summaryStub],
    [Config.node, Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(baseConfig) }))],
  ])
}

const shrinkEnv = AppNodeBuilder.build(compactionTestNode, [
  [Provider.node, ProviderTest.fake({ model: createModel() }).layer],
  [SessionProcessor.node, processorSequenceLayer(["compact", "continue"])],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, outputTokenMax: REQUESTED_OUTPUT })],
  [SessionSummary.node, summaryStub],
  [Config.node, Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(baseConfig) }))],
])

const chunkCaptured: LLM.StreamInput[] = []
let chunkSummary = 0
const chunkLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      chunkCaptured.push(input)
      chunkSummary++
      const usage = new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
      return Stream.make(
        LLMEvent.textStart({ id: `summary-${chunkSummary}` }),
        LLMEvent.textDelta({ id: `summary-${chunkSummary}`, text: `summary-${chunkSummary}` }),
        LLMEvent.textEnd({ id: `summary-${chunkSummary}` }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
        LLMEvent.finish({ reason: "stop", usage }),
      )
    },
  }),
)

const chunkEnv = AppNodeBuilder.build(compactionTestNode, [
  [Provider.node, ProviderTest.fake({ model: createModel() }).layer],
  [LLM.node, chunkLLM],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, outputTokenMax: REQUESTED_OUTPUT })],
  [SessionSummary.node, summaryStub],
  [Config.node, Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(baseConfig) }))],
])

const it = testEffect(env("compact"))
const itContinue = testEffect(env("continue"))
const itChunk = testEffect(chunkEnv)
const itShrink = testEffect(shrinkEnv)

// ---------------------------------------------------------------------------
// Session builders
// ---------------------------------------------------------------------------

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function createCompactionMarker(sessionID: SessionID, overflow?: boolean) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: true,
        overflow,
      })
      return msg
    }),
  )
}

/**
 * A transcript the size a real session has when overflow-compaction fires.
 *
 * The auto-compaction trigger reads MEASURED provider tokens from the previous
 * assistant step (usable() = 234_496 here), but content keeps accumulating
 * locally after the last accepted request: a single turn's tool results land
 * in the transcript without any provider round-trip, and the request that
 * would have carried them is the one the provider rejects. Six user turns of
 * 170k characters (~42.5k estimated tokens each) model that state: ~255k
 * estimated tokens, comfortably past the 234_496 trigger and past what the
 * provider accepted.
 */
function buildOverflowedTranscript(sessionID: SessionID) {
  return Effect.gen(function* () {
    for (let i = 0; i < 6; i++) {
      yield* createUserMessage(sessionID, `turn ${i}: ` + "x".repeat(170_000))
    }
  })
}

/** Estimated input tokens of the compaction request the code actually built. */
function capturedPromptTokens(streamInput: LLM.StreamInput) {
  const text = streamInput.messages
    .flatMap((msg): unknown[] => (Array.isArray(msg.content) ? msg.content : []))
    .flatMap((part) =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
        ? [String(part.text)]
        : [],
    )
    .join("\n")
  expect(text.length).toBeGreaterThan(0)
  return Token.estimate(text)
}

function capturedPromptText(streamInput: LLM.StreamInput) {
  return streamInput.messages
    .flatMap((msg): unknown[] => (Array.isArray(msg.content) ? msg.content : []))
    .flatMap((part) =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
        ? [String(part.text)]
        : [],
    )
    .join("\n")
}

function requestedOutputFor(estimatedInputTokens: number) {
  return requestedOutput({
    model: createModel(),
    estimatedInputTokens,
    outputTokenMax: REQUESTED_OUTPUT,
    thinkingBudget: 0,
    dynamic: true,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session.compaction death loop (256k configured / 260k real / 32,678 requested output)", () => {
  it.effect("pins the trigger arithmetic the loop is built on", () =>
    Effect.sync(() => {
      const model = createModel()
      // floor of the dynamic output window: min(16_384, ceiling), half-context capped
      expect(outputFloor({ model, outputTokenMax: REQUESTED_OUTPUT })).toBe(16_384)
      // slack held back from the dynamic window
      expect(safety(CONFIGURED_CONTEXT)).toBe(5_120)
      // auto-compaction triggers at 256_000 - (16_384 + 5_120) = 234_496 measured tokens
      expect(usable({ cfg: baseConfig, model, outputTokenMax: REQUESTED_OUTPUT })).toBe(234_496)
      // at a ~255k-token estimated input the requested output cannot shrink below
      // the floor, so every request -- including compaction's own -- adds 16_384
      // on top of an input that already fills the window
      expect(requestedOutputFor(255_000)).toBe(16_384)
    }),
  )

  it.instance(
    "the compaction request itself must fit the model window",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* buildOverflowedTranscript(session.id)
        const marker = yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const result = yield* SessionCompaction.use.process({
          parentID: marker.id,
          messages: msgs,
          sessionID: session.id,
          auto: true,
        })

        expect(captured.length).toBe(2)
        const attempts = captured.map(capturedPromptTokens)

        // Every bounded attempt, including the mandated smaller retry, must fit
        // the window by the same arithmetic used to size provider output.
        expect(attempts.every((tokens) => tokens + requestedOutputFor(tokens) <= CONFIGURED_CONTEXT)).toBe(true)
        expect(attempts[1]!).toBeLessThan(attempts[0]!)

        // And a request that was doomed must not be reported as a successful
        // compaction either.
        expect(result).toBe("stop")
      }),
    60_000,
  )

  itShrink.instance(
    "retries one compacted summary request with the newest half of its head",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "oldest " + "a".repeat(80_000))
        yield* createUserMessage(session.id, "newest " + "b".repeat(80_000))
        const marker = yield* createCompactionMarker(session.id)

        const result = yield* SessionCompaction.use.process({
          parentID: marker.id,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })

        expect(result).toBe("continue")
        expect(captured).toHaveLength(2)
        const first = capturedPromptTokens(captured[0]!)
        const second = capturedPromptTokens(captured[1]!)
        expect(second).toBeLessThan(first)
        expect(second + requestedOutputFor(second)).toBeLessThanOrEqual(CONFIGURED_CONTEXT)
      }),
    60_000,
  )

  itChunk.instance(
    "chunk-summarizes a head over three times the budget and chains every request",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        for (let i = 0; i < 15; i++) {
          yield* createUserMessage(session.id, `chunk turn ${i}: ` + String(i).repeat(170_000))
        }
        const marker = yield* createCompactionMarker(session.id)

        const result = yield* SessionCompaction.use.process({
          parentID: marker.id,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: false,
        })

        expect(result).toBe("continue")
        expect(chunkCaptured.length).toBeGreaterThanOrEqual(4)
        expect(
          chunkCaptured.every((input) => {
            const tokens = capturedPromptTokens(input)
            return tokens + requestedOutputFor(tokens) <= CONFIGURED_CONTEXT
          }),
        ).toBe(true)
        for (let i = 1; i < chunkCaptured.length; i++) {
          const text = capturedPromptText(chunkCaptured[i]!)
          expect(text).toContain("<prior-summary>")
          expect(text).toContain(`summary-${i}`)
        }
      }),
    60_000,
  )

  it.instance(
    "a failed compaction is not retried with the same over-window selection",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* buildOverflowedTranscript(session.id)

        // Attempt #1: overflow-triggered compaction; the fake processor
        // reports what the provider does to it -- context overflow ("compact").
        const marker1 = yield* createCompactionMarker(session.id, true)
        const first = yield* SessionCompaction.use.process({
          parentID: marker1.id,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: true,
          overflow: true,
        })
        expect(first).toBe("stop")
        expect(captured.length).toBe(2)
        const firstTokens = capturedPromptTokens(captured[0]!)
        const retryTokens = capturedPromptTokens(captured[1]!)
        expect(retryTokens).toBeLessThan(firstTokens)

        // The errored summary assistant persisted by attempt #1 carries the
        // user-visible error string.
        const errored = (yield* ssn.messages({ sessionID: session.id })).find(
          (msg) => msg.info.role === "assistant" && msg.info.summary && msg.info.error,
        )
        expect(JSON.stringify(errored?.info.role === "assistant" ? errored.info.error : {})).toContain(
          "too large to compact",
        )
        expect(JSON.stringify(errored)).toContain("Configured context limit: 256000 tokens")
        expect(JSON.stringify(errored)).toContain("Raise the model context limit, prune session history, or start a new session")

        const afterFailure = yield* ssn.messages({ sessionID: session.id })
        expect(
          yield* SessionCompaction.use.isOverflow({
            tokens: {
              input: 255_000,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            model: createModel(),
            sessionID: session.id,
            messages: afterFailure,
          }),
        ).toBe(false)

        // A queued auto marker for the unchanged transcript is suppressed
        // without making a third provider request.
        const marker2 = yield* createCompactionMarker(session.id, true)
        const second = yield* SessionCompaction.use.process({
          parentID: marker2.id,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: true,
          overflow: true,
        })
        expect(second).toBe("stop")
        expect(captured.length).toBe(2)

        // The only retry used the smaller selection and remained in-window.
        expect(retryTokens + requestedOutputFor(retryTokens)).toBeLessThanOrEqual(CONFIGURED_CONTEXT)
      }),
    60_000,
  )

  itContinue.instance(
    "replays oversized text as a byte-count placeholder",
    () =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "root")
        const oversized = "z".repeat(CONFIGURED_CONTEXT * 4)
        yield* createUserMessage(session.id, oversized)
        const marker = yield* createCompactionMarker(session.id, true)

        const result = yield* SessionCompaction.use.process({
          parentID: marker.id,
          messages: yield* ssn.messages({ sessionID: session.id }),
          sessionID: session.id,
          auto: true,
          overflow: true,
        })

        const replayed = (yield* ssn.messages({ sessionID: session.id })).at(-1)
        expect(result).toBe("continue")
        expect(replayed?.info.role).toBe("user")
        expect(replayed?.parts).toHaveLength(1)
        expect(replayed?.parts[0]?.type).toBe("text")
        if (replayed?.parts[0]?.type === "text") {
          expect(replayed.parts[0].text).toBe(`[Oversized text omitted from replay: ${oversized.length} bytes]`)
          expect(replayed.parts[0].text).not.toContain("zzzz")
        }
      }),
    60_000,
  )
})
