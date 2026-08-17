import { afterEach, describe, expect, mock, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { APICallError } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Config } from "@/config/config"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "@/util/token"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"

import { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  estimateInput,
  MEDIA_TOKENS,
  outputCeiling,
  outputFloor,
  requestedOutput,
  thinkingBudget,
} from "@/session/output-window"
import { usable } from "@/session/overflow"
import { jsonSchema } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"
import { Agent } from "@/agent/agent"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const usage = (input: ConstructorParameters<typeof Usage>[0]) => new Usage(input)

const basicUsage = () => usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
  variants?: Provider.Model["variants"]
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { id: "test-model", url: "https://example.com", npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
    variants: opts.variants,
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

function createUserMessage(sessionID: SessionID, text: string, variant?: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: variant ? { ...ref, variant } : ref,
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

function createAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string) {
  return SessionNs.Service.use((ssn) =>
    ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }),
  )
}

function createSummaryAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: "compaction",
        agent: "compaction",
        path: { cwd: root, root },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID,
        summary: true,
        time: { created: Date.now() },
        finish: "end_turn",
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
      })
      return msg
    }),
  )
}

function createCompactionMarker(sessionID: SessionID) {
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
        auto: false,
      })
    }),
  )
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
  capture?: (streamInput: LLM.StreamInput) => void,
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")((streamInput) => {
      capture?.(streamInput)
      return Effect.succeed(result)
    }),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function processorLayer(result: "continue" | "compact", capture?: (streamInput: LLM.StreamInput) => void) {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result, capture))),
    }),
  )
}

function cfg(compaction?: ConfigV1.Info["compaction"]) {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ ...base, compaction }) }))
}

const defaultProvider = wide()
const compactionTestNode = LayerNode.group([
  SessionCompaction.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const env = AppNodeBuilder.build(compactionTestNode, [
  [Provider.node, defaultProvider.layer],
  [SessionProcessorModule.SessionProcessor.node, processorLayer("continue")],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, outputTokenMax: 64_000 })],
])

const it = testEffect(env)

const compactionEnv = AppNodeBuilder.build(
  LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
)
const itCompaction = testEffect(compactionEnv)

type CompactionProcessOptions = {
  result?: "continue" | "compact"
  llm?: Layer.Layer<LLM.Service>
  plugin?: Layer.Layer<Plugin.Service>
  provider?: ReturnType<typeof wide>
  config?: Layer.Layer<Config.Service>
  capture?: (streamInput: LLM.StreamInput) => void
}

function withCompaction(options?: CompactionProcessOptions) {
  return Effect.provide(compactionProcessLayer(options))
}

function compactionProcessLayer(options?: CompactionProcessOptions) {
  const replacements: LayerNode.Replacements = [
    [Provider.node, (options?.provider ?? wide()).layer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [SessionSummary.node, summary],
  ]
  if (!options?.llm) {
    return AppNodeBuilder.build(compactionTestNode, [
      ...replacements,
      [SessionProcessorModule.SessionProcessor.node, processorLayer(options?.result ?? "continue", options?.capture)],
      ...(options?.plugin ? ([[Plugin.node, options.plugin]] as const) : []),
      ...(options?.config ? ([[Config.node, options.config]] as const) : []),
    ])
  }
  return AppNodeBuilder.build(compactionTestNode, [
    ...replacements,
    [LLM.node, options.llm],
    ...(options?.plugin ? ([[Plugin.node, options.plugin]] as const) : []),
    ...(options?.config ? ([[Config.node, options.config]] as const) : []),
  ])
}

function createSummaryCompaction(sessionID: SessionID) {
  return SessionCompaction.use.create({ sessionID, agent: "build", model: ref, auto: false })
}

function readCompactionPart(sessionID: SessionID) {
  return SessionNs.use
    .messages({ sessionID })
    .pipe(
      Effect.map((messages) =>
        messages.at(-2)?.parts.find((item): item is SessionV1.CompactionPart => item.type === "compaction"),
      ),
    )
}

function llm() {
  const queue: Array<
    Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)
  > = []

  return {
    push(stream: Stream.Stream<LLMEvent, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown>)) {
      queue.push(stream)
    },
    llmLayer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
  }
}

function reply(
  text: string,
  capture?: (input: LLM.StreamInput) => void,
): (input: LLM.StreamInput) => Stream.Stream<LLMEvent, unknown> {
  return (input) => {
    capture?.(input)
    return Stream.make(
      LLMEvent.textStart({ id: "txt-0" }),
      LLMEvent.textDelta({ id: "txt-0", text }),
      LLMEvent.textEnd({ id: "txt-0" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: basicUsage(),
      }),
      LLMEvent.finish({
        reason: "stop",
        usage: basicUsage(),
      }),
    )
  }
}

function plugin(ready: Deferred.Deferred<void>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void)).pipe(
        Effect.andThen(Effect.never),
        Effect.as(output),
      )
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function autocontinue(enabled: boolean) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.compaction.autocontinue") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { enabled: boolean }).enabled = enabled
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

const passthroughPlugin = Plugin.Service.of({
  trigger: <Name extends string, Input, Output>(_name: Name, _input: Input, output: Output) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})

function prepareRequest(input: {
  model: Provider.Model
  messages: LLM.StreamInput["messages"]
  variant?: string
  cfg?: ConfigV1.Info
  tools?: LLM.StreamInput["tools"]
}) {
  return LLMRequestPrep.prepare({
    user: {
      id: MessageID.ascending(),
      role: "user",
      sessionID: SessionID.create(),
      agent: "build",
      model: { providerID: ref.providerID, modelID: ref.modelID, variant: input.variant },
      time: { created: Date.now() },
    },
    sessionID: SessionID.create(),
    model: input.model,
    agent: {
      name: "build",
      mode: "primary",
      permission: [],
      prompt: "test",
      options: {},
    } satisfies Agent.Info,
    system: [],
    messages: input.messages,
    tools: input.tools ?? {},
    provider: ProviderTest.info({}, input.model),
    auth: undefined,
    plugin: passthroughPlugin,
    flags: { client: "test", outputTokenMax: input.model.limit.output || undefined } as RuntimeFlags.Info,
    cfg: input.cfg,
    isWorkflow: false,
  })
}

const cfgOf = (compaction?: ConfigV1.Info["compaction"]) => ({ compaction }) as ConfigV1.Info

const captured: LLM.StreamInput[] = []
afterEach(() => {
  captured.length = 0
})

function compactionContext(context: string) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { context: string[] }).context.push(context)
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

describe("session.compaction.isOverflow", () => {
  it.live(
    "keeps a 200k context open at 150k input and shrinks the requested output window",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 64_000 })
        const tokens = { input: 150_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
        // 200k context - 150k input - safety(200k)=4k
        expect(requestedOutput({ model, estimatedInputTokens: 150_000, outputTokenMax: 64_000 })).toBe(46_000)
      }),
    ),
  )

  it.live(
    "compacts when the remaining context is below the output floor",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 64_000 })
        const tokens = { input: 195_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "keeps input-limit behavior and requests the provider output ceiling",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 200_000, output: 64_000 })
        const tokens = { input: 181_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
        expect(requestedOutput({ model, estimatedInputTokens: 181_000, outputTokenMax: 64_000 })).toBe(64_000)
      }),
    ),
  )

  test("requested output never exceeds the configured provider ceiling", () => {
    const model = createModel({ context: 200_000, output: 64_000 })
    expect(requestedOutput({ model, estimatedInputTokens: 100_000, outputTokenMax: 20_000 })).toBe(20_000)
  })

  it.live(
    "returns true when token count exceeds usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 86_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when token count within usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "includes cache.read in token count",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "respects input limit for input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when input/output are within input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when output within limit with input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "reserves the existing compaction buffer when limit.input is set",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })

        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 198K; usable = limit.input - 20K = 180K
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "uses the output floor and safety margin without limit.input",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })

        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(true)
      }),
    ),
  )

  it.live(
    "keeps the input-limit reserve while context-only models use the output floor",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        // Two models with identical context/output limits, differing only in limit.input
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })

        // The two branches now sit ~400 tokens apart: the input-limit branch
        // reserves a flat 20k, the context-only branch reserves
        // max(floor 16,384, 4,096) + safety(200k)=4,000 = 20,384.
        // 179,800 is inside the input-limit window but past the context-only one.
        const tokens = { input: 169_800, output: 5_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = yield* compact.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = yield* compact.isOverflow({ tokens, model: withoutInputLimit })

        expect(withLimit).toBe(false)
        expect(withoutLimit).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when model context limit is 0",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when compaction.auto is disabled",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model })).toBe(false)
        }),
      {
        config: {
          compaction: { auto: false },
        },
      },
    ),
  )
})

describe("session.compaction.create", () => {
  it.live(
    "creates a compaction user message and part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service

        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
          overflow: true,
        })
      }),
    ),
  )

  it.live.skip(
    "projects a compaction message to v2 (v2 projector disabled)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const v2 = yield* SessionV2.Service.use((svc) => svc.messages({ sessionID: info.id })).pipe(
          Effect.provide(AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])),
        )
        expect(v2.at(-1)).toMatchObject({
          type: "compaction",
          reason: "auto",
          summary: "",
        })
      }),
    ),
  )
})

describe("session.compaction.prune", () => {
  it.live(
    "compacts old completed tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const a = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "text",
            text: "first",
          })
          const b: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: a.id,
            time: { created: Date.now() },
            finish: "end_turn",
          }
          yield* ssn.updateMessage(b)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: b.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          for (const text of ["second", "third"]) {
            const msg = yield* ssn.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: info.id,
              type: "text",
              text,
            })
          }

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeNumber()
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "skips protected skill tool output",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const a = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: a.id,
          sessionID: info.id,
          type: "text",
          text: "first",
        })
        const b: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: a.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* ssn.updateMessage(b)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: b.id,
          sessionID: info.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "skill",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(200_000),
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        for (const text of ["second", "third"]) {
          const msg = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: info.id,
            type: "text",
            text,
          })
        }

        yield* compact.prune({ sessionID: info.id })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      }),
    ),
  )
})

describe("session.compaction.process", () => {
  it.instance(
    "throws when parent is not a user message",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const reply = yield* createAssistantMessage(session.id, msg.id, test.directory)
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const exit = yield* Effect.exit(
        SessionCompaction.use.process({
          parentID: reply.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).toContain(`Compaction parent must be a user message: ${reply.id}`)
        }
      }
    }),
  )

  it.instance(
    "publishes compacted event on continue",
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const done = yield* Deferred.make<void, Error>()
      const seen: string[] = []
      const unsub = yield* events.listen((evt) => {
        seen.push(evt.type)
        if (evt.type !== SessionCompaction.Event.Compacted.type) return Effect.void
        if ((evt.data as typeof SessionCompaction.Event.Compacted.data.Type).sessionID !== session.id)
          return Effect.void
        Deferred.doneUnsafe(done, Effect.void)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      yield* Deferred.await(done).pipe(Effect.timeout("500 millis"))
      expect(result).toBe("continue")
      expect(seen).toContain(SessionCompaction.Event.Compacted.type)
      expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
    }),
  )

  itCompaction.instance(
    "marks summary message as errored on compact result",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const summary = (yield* ssn.messages({ sessionID: session.id })).find(
        (msg) => msg.info.role === "assistant" && msg.info.summary,
      )

      expect(result).toBe("stop")
      expect(summary?.info.role).toBe("assistant")
      if (summary?.info.role === "assistant") {
        expect(summary.info.finish).toBe("error")
        expect(JSON.stringify(summary.info.error)).toContain("Session too large to compact")
      }
    }).pipe(withCompaction({ result: "compact" })),
  )

  it.instance(
    "adds synthetic continue prompt when auto is enabled",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const all = yield* ssn.messages({ sessionID: session.id })
      const last = all.at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      expect(last?.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
        metadata: { compaction_continue: true },
      })
      if (last?.parts[0]?.type === "text") {
        expect(last.parts[0].text).toContain("Continue if you have next steps")
      }
    }),
  )

  itCompaction.instance(
    "summary call does not inherit the user's thinking variant",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      // "max" maps to a ~31,999 token thinking budget on pre-4.6 Claude, which
      // max_tokens must then exceed. Inheriting it makes the compaction call the
      // largest request in the session and can lock a full context into a
      // compact-fail loop.
      yield* createUserMessage(session.id, "first", "max")
      yield* createUserMessage(session.id, "second", "max")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      expect(captured.length).toBeGreaterThan(0)
      expect(captured.at(-1)?.user.model.variant).toBeUndefined()

      // The persisted summary message records the stripped variant too.
      const after = yield* ssn.messages({ sessionID: session.id })
      const summaryMsg = after.map((m) => m.info).findLast((i) => i.role === "assistant" && i.summary)
      expect(summaryMsg).toBeTruthy()
      expect((summaryMsg as SessionV1.Assistant).variant).toBeUndefined()
    }).pipe(withCompaction({ capture: (streamInput) => captured.push(streamInput) })),
  )

  itCompaction.instance(
    "persists tail_start_id for retained recent turns",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      const keep = yield* createUserMessage(session.id, "second")
      yield* createUserMessage(session.id, "third")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) })),
  )

  itCompaction.instance(
    "shrinks retained tail to fit preserve token budget",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "first")
      yield* createUserMessage(session.id, "x".repeat(2_000))
      const keep = yield* createUserMessage(session.id, "tiny")
      yield* createSummaryCompaction(session.id)

      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({
        parentID: parent!,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 100 }) })),
  )

  itCompaction.instance(
    "falls back to full summary when even one recent turn exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "first")
        yield* createUserMessage(session.id, "y".repeat(2_000))
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("yyyy")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 20 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "falls back to full summary when retained tail media exceeds preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent image turn")
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: recent.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "big.png",
          url: `data:image/png;base64,${"a".repeat(4_000)}`,
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBeUndefined()
        expect(captured).toContain("recent image turn")
        expect(captured).toContain("Attached image/png: big.png")
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "retains a split turn suffix when a later message fits the preserve token budget",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary", (input) => (captured = JSON.stringify(input.messages))))
      return Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older")
        const recent = yield* createUserMessage(session.id, "recent turn")
        const large = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: large.id,
          sessionID: session.id,
          type: "text",
          text: "z".repeat(2_000),
        })
        const keep = yield* createAssistantMessage(session.id, recent.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: keep.id,
          sessionID: session.id,
          type: "text",
          text: "keep tail",
        })
        yield* createSummaryCompaction(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        const part = yield* readCompactionPart(session.id)
        expect(part?.type).toBe("compaction")
        expect(part?.tail_start_id).toBe(keep.id)
        expect(captured).toContain("zzzz")
        expect(captured).not.toContain("keep tail")

        const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        expect(filtered.map((msg) => msg.info.id).slice(0, 3)).toEqual([parent!, expect.any(String), keep.id])
        expect(filtered[1]?.info.role).toBe("assistant")
        expect(filtered[1]?.info.role === "assistant" ? filtered[1].info.summary : false).toBe(true)
        expect(filtered.map((msg) => msg.info.id)).not.toContain(large.id)
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 1, preserve_recent_tokens: 100 }) }))
    },
    { git: true },
  )

  itCompaction.instance(
    "allows plugins to disable synthetic continue prompt",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const msg = yield* createUserMessage(session.id, "hello")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
      })

      const all = yield* ssn.messages({ sessionID: session.id })
      const last = all.at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("assistant")
      expect(
        all.some(
          (msg) =>
            msg.info.role === "user" &&
            msg.parts.some(
              (part) => part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
            ),
        ),
      ).toBe(false)
    }).pipe(withCompaction({ plugin: autocontinue(false) })),
  )

  it.instance(
    "replays the prior user turn on overflow when earlier context exists",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "root")
      const replay = yield* createUserMessage(session.id, "image")
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: replay.id,
        sessionID: session.id,
        type: "file",
        mime: "image/png",
        filename: "cat.png",
        url: "https://example.com/cat.png",
      })
      const msg = yield* createUserMessage(session.id, "current")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      expect(last?.parts.some((part) => part.type === "file")).toBe(false)
      expect(
        last?.parts.some((part) => part.type === "text" && part.text.includes("Attached image/png: cat.png")),
      ).toBe(true)
    }),
  )

  it.instance(
    "falls back to overflow guidance when no replayable turn exists",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "earlier")
      const msg = yield* createUserMessage(session.id, "current")
      const msgs = yield* ssn.messages({ sessionID: session.id })

      const result = yield* SessionCompaction.use.process({
        parentID: msg.id,
        messages: msgs,
        sessionID: session.id,
        auto: true,
        overflow: true,
      })

      const last = (yield* ssn.messages({ sessionID: session.id })).at(-1)

      expect(result).toBe("continue")
      expect(last?.info.role).toBe("user")
      if (last?.parts[0]?.type === "text") {
        expect(last.parts[0].text).toContain("previous request exceeded the provider's size limit")
      }
    }),
  )

  itCompaction.instance(
    "stops quickly when aborted during retry backoff",
    () => {
      const stub = llm()
      stub.push(
        Stream.fromAsyncIterable(
          {
            async *[Symbol.asyncIterator]() {
              yield LLMEvent.stepStart({ index: 0 })
              throw new APICallError({
                message: "boom",
                url: "https://example.com/v1/chat/completions",
                requestBodyValues: {},
                statusCode: 503,
                responseHeaders: { "retry-after-ms": "10000" },
                responseBody: '{"error":"boom"}',
                isRetryable: true,
              })
            },
          },
          (err) => err,
        ),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const ready = yield* Deferred.make<void>()
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID !== session.id || data.status.type !== "retry") return Effect.void
          Deferred.doneUnsafe(ready, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)

        const fiber = yield* SessionCompaction.use
          .process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            auto: false,
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
        const start = Date.now()
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(Date.now() - start).toBeLessThan(250)
        }
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
    { timeout: 10_000 },
  )

  itCompaction.instance(
    "does not leave a summary assistant when aborted before processor setup",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        return yield* Effect.gen(function* () {
          const ssn = yield* SessionNs.Service
          const session = yield* ssn.create({})
          const msg = yield* createUserMessage(session.id, "hello")
          const msgs = yield* ssn.messages({ sessionID: session.id })
          const fiber = yield* SessionCompaction.use
            .process({
              parentID: msg.id,
              messages: msgs,
              sessionID: session.id,
              auto: false,
            })
            .pipe(Effect.forkChild)

          yield* Deferred.await(ready).pipe(Effect.timeout("1 second"))
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
          const all = yield* ssn.messages({ sessionID: session.id })

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
        }).pipe(withCompaction({ plugin: plugin(ready) }))
      }),
    { git: true },
  )

  itCompaction.instance(
    "silently drops reasoning-delta arriving without prior reasoning-start",
    () => {
      // Regression: PR initially auto-created a reasoning Part for orphan deltas (no preceding
      // reasoning-start). Reverted to match dev — drop silently. Pinned here so any future
      // change to processor.ts reasoning-delta handling triggers this test.
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.reasoningDelta({ id: "orphan-1", text: "stray reasoning" }),
          LLMEvent.textStart({ id: "txt-0" }),
          LLMEvent.textDelta({ id: "txt-0", text: "summary" }),
          LLMEvent.textEnd({ id: "txt-0" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: basicUsage() }),
          LLMEvent.finish({ reason: "stop", usage: basicUsage() }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({
          parentID: msg.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )
        expect(summary?.parts.some((part) => part.type === "reasoning")).toBe(false)
        // Sanity: the text part still got through.
        expect(summary?.parts.some((part) => part.type === "text" && part.text === "summary")).toBe(true)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "does not allow tool calls while generating the summary",
    () => {
      const stub = llm()
      stub.push(
        Stream.make(
          LLMEvent.toolCall({ id: "call-1", name: "_noop", input: {} }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: basicUsage(),
          }),
          LLMEvent.finish({
            reason: "tool-calls",
            usage: basicUsage(),
          }),
        ),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        const msg = yield* createUserMessage(session.id, "hello")
        const msgs = yield* ssn.messages({ sessionID: session.id })
        yield* SessionCompaction.use.process({ parentID: msg.id, messages: msgs, sessionID: session.id, auto: false })

        const summary = (yield* ssn.messages({ sessionID: session.id })).find(
          (item) => item.info.role === "assistant" && item.info.summary,
        )

        expect(summary?.info.role).toBe("assistant")
        expect(summary?.parts.some((part) => part.type === "tool")).toBe(false)
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "summarizes only the head while keeping recent tail out of summary input",
    () => {
      const stub = llm()
      let messages: LLM.StreamInput["messages"] = []
      stub.push(
        reply("summary", (input) => {
          messages = input.messages
        }),
      )
      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createUserMessage(session.id, "and this one too")
        yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        const captured = JSON.stringify(messages)
        expect(messages).toHaveLength(1)
        expect(messages[0]?.role).toBe("user")
        expect(captured).toContain("Here is the conversation so far:")
        expect(captured).toContain("<conversation>")
        expect(captured.indexOf("[User]: older context")).toBeLessThan(
          captured.indexOf("Create a new anchored summary"),
        )
        expect(captured).toContain("[User]: older context")
        expect(captured).not.toContain("keep this turn")
        expect(captured).not.toContain("and this one too")
        expect(captured).not.toContain("What did we do so far?")
      }).pipe(
        withCompaction({
          llm: stub.llmLayer,
          config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "anchors repeated compactions with the previous summary",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(reply("summary one"))
      stub.push(
        reply("summary two", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createCompactionMarker(session.id)

        let msgs = yield* ssn.messages({ sessionID: session.id })
        let parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        yield* createUserMessage(session.id, "latest turn")
        yield* createCompactionMarker(session.id)

        msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        expect(captured).toContain("<prior-summary>")
        expect(captured).toContain("summary one")
        expect(captured.match(/summary one/g)?.length).toBe(1)
        expect(captured.indexOf("latest turn")).toBeLessThan(captured.indexOf("<prior-summary>"))
        expect(captured).toContain("summary of the conversation before the <conversation> above")
        expect(captured).toContain("## Important Details")
        expect(captured).toContain("## Work State")
      }).pipe(withCompaction({ llm: stub.llmLayer }))
    },
    { git: true },
  )

  itCompaction.instance(
    "keeps plugin context outside the serialized conversation",
    () => {
      const stub = llm()
      let captured = ""
      stub.push(
        reply("summary", (input) => {
          captured = JSON.stringify(input.messages)
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const session = yield* ssn.create({})
        yield* createUserMessage(session.id, "older context")
        yield* createUserMessage(session.id, "keep this turn")
        yield* createUserMessage(session.id, "and this one too")
        yield* createCompactionMarker(session.id)

        const msgs = yield* ssn.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({
          parentID: parent!,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        })

        expect(captured).toContain("Prioritize unresolved migration details")
        expect(captured.indexOf("</conversation>")).toBeLessThan(
          captured.indexOf("Prioritize unresolved migration details"),
        )
      }).pipe(
        withCompaction({
          llm: stub.llmLayer,
          plugin: compactionContext("Prioritize unresolved migration details"),
        }),
      )
    },
    { git: true },
  )

  itCompaction.instance(
    "serializes repeated compaction history as one user message",
    () => {
      const stub = llm()
      let captured: LLM.StreamInput["messages"] = []
      stub.push(
        reply("summary two", (input) => {
          captured = input.messages
        }),
      )

      return Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const test = yield* TestInstance
        const session = yield* ssn.create({})
        const turn = yield* createUserMessage(session.id, "original request")
        const kept = yield* createAssistantMessage(session.id, turn.id, test.directory)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: kept.id,
          sessionID: session.id,
          type: "tool",
          callID: "read-call",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "src/index.ts" },
            output: "file contents",
            title: "src/index.ts",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })

        const previous = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          model: ref,
          sessionID: session.id,
          agent: "build",
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: previous.id,
          sessionID: session.id,
          type: "compaction",
          auto: false,
          tail_start_id: kept.id,
        })
        yield* createSummaryAssistantMessage(session.id, previous.id, test.directory, "summary one")
        yield* createCompactionMarker(session.id)

        const msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

        expect(captured).toHaveLength(1)
        expect(captured[0]?.role).toBe("user")
        expect(JSON.stringify(captured)).toContain('[Assistant tool call]: read({\\"filePath\\":\\"src/index.ts\\"})')
        expect(JSON.stringify(captured)).toContain("[Tool result]: file contents")
        expect(JSON.stringify(captured)).not.toContain('\\"role\\":\\"assistant\\"')
      }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 0 }) }))
    },
    { git: true },
  )

  itCompaction.instance("keeps recent pre-compaction turns across repeated compactions", () => {
    const stub = llm()
    stub.push(reply("summary one"))
    stub.push(reply("summary two"))

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const u1 = yield* createUserMessage(session.id, "one")
      const u2 = yield* createUserMessage(session.id, "two")
      const u3 = yield* createUserMessage(session.id, "three")
      yield* createCompactionMarker(session.id)

      let msgs = yield* ssn.messages({ sessionID: session.id })
      let parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const u4 = yield* createUserMessage(session.id, "four")
      yield* createCompactionMarker(session.id)

      msgs = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const filtered = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      const ids = filtered.map((msg) => msg.info.id)

      expect(ids).not.toContain(u1.id)
      expect(ids).not.toContain(u2.id)
      expect(ids).toContain(u3.id)
      expect(ids).toContain(u4.id)
      expect(filtered.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(true)
      expect(
        filtered.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")),
      ).toBe(true)
    }).pipe(withCompaction({ llm: stub.llmLayer, config: cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }) }))
  })

  itCompaction.instance(
    "ignores previous summaries when sizing the retained tail",
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const test = yield* TestInstance
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "older")
      const keep = yield* createUserMessage(session.id, "keep this turn")
      const keepReply = yield* createAssistantMessage(session.id, keep.id, test.directory)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: keepReply.id,
        sessionID: session.id,
        type: "text",
        text: "keep reply",
      })

      yield* createCompactionMarker(session.id)
      const firstCompaction = (yield* ssn.messages({ sessionID: session.id })).at(-1)?.info.id
      expect(firstCompaction).toBeTruthy()
      yield* createSummaryAssistantMessage(session.id, firstCompaction!, test.directory, "summary ".repeat(800))

      const recent = yield* createUserMessage(session.id, "recent turn")
      const recentReply = yield* createAssistantMessage(session.id, recent.id, test.directory)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: recentReply.id,
        sessionID: session.id,
        type: "text",
        text: "recent reply",
      })

      yield* createCompactionMarker(session.id)
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const parent = msgs.at(-1)?.info.id
      expect(parent).toBeTruthy()
      yield* SessionCompaction.use.process({ parentID: parent!, messages: msgs, sessionID: session.id, auto: false })

      const part = yield* readCompactionPart(session.id)
      expect(part?.type).toBe("compaction")
      expect(part?.tail_start_id).toBe(keep.id)
    }).pipe(withCompaction({ config: cfg({ tail_turns: 2, preserve_recent_tokens: 500 }) })),
  )
})

describe("session.output-window", () => {
  const ANTHROPIC_LIKE = { context: 200_000, output: 64_000 }

  test("no pre-flight rejection: a nearly-full context still prepares a request", async () => {
    const model = createModel(ANTHROPIC_LIKE)
    // ~1M estimated tokens against a 200k window. Sizing must clamp to the
    // floor and hand the request to the provider, which is what makes the
    // existing ContextOverflowError -> needsCompaction recovery reachable.
    const exit = await Effect.runPromiseExit(
      prepareRequest({ model, messages: [{ role: "user", content: "x".repeat(4_000_000) }] }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.params.maxOutputTokens).toBe(16_384)
  })

  test("model with limit.input is untouched: full ceiling, legacy trigger", () => {
    const model = createModel({ context: 200_000, input: 200_000, output: 64_000 })
    expect(requestedOutput({ model, estimatedInputTokens: 190_000, outputTokenMax: 64_000 })).toBe(64_000)
    expect(outputCeiling(model, 64_000)).toBe(64_000)
    // Legacy formula: limit.input - min(COMPACTION_BUFFER, ceiling)
    expect(usable({ cfg: cfgOf(), model, outputTokenMax: 64_000 })).toBe(200_000 - 20_000)
  })

  test("limit.output === 0 derives a floor from the ceiling guard, never 0", () => {
    const model = createModel({ context: 128_000, output: 0 })
    expect(outputFloor({ model, outputTokenMax: 32_000 })).toBe(16_384)
    // Would collapse toward max_tokens:1 if the floor came from limit.output.
    expect(requestedOutput({ model, estimatedInputTokens: 127_500, outputTokenMax: 32_000 })).toBe(16_384)
    expect(usable({ cfg: cfgOf(), model, outputTokenMax: 32_000 })).toBe(128_000 - 16_384 - 2_560)
  })

  test("8k-context fan-out target stays workable and never over-reserves", () => {
    // Reachable at LLM whim now that subagents pick a model per call. The
    // limit.output:0 guard resolves to 32k, which is larger than this entire
    // window, so both the ceiling and the reserve have to be clamped.
    const model = createModel({ context: 8_000, output: 0 })
    expect(outputCeiling(model, 32_000)).toBe(8_000)
    expect(outputFloor({ model, outputTokenMax: 32_000 })).toBe(4_000)

    const room = usable({ cfg: cfgOf(), model, outputTokenMax: 32_000 })
    expect(room).toBeGreaterThan(0)
    expect(room).toBe(4_000)

    const requested = requestedOutput({ model, estimatedInputTokens: 3_000, outputTokenMax: 32_000 })
    expect(requested).toBe(4_000)
    expect(requested).toBeLessThanOrEqual(model.limit.context)
  })

  test("a large base64 image costs a flat rate instead of its payload length", () => {
    const image = "A".repeat(1_000_000)
    const messages = [
      { role: "user" as const, content: [{ type: "file" as const, mediaType: "image/png", data: image }] },
    ]
    // The old estimator counted the base64 string: ~250k tokens for ~1.6k of real cost.
    expect(Token.estimate(JSON.stringify(messages))).toBeGreaterThan(200_000)
    expect(estimateInput({ messages })).toBeLessThan(MEDIA_TOKENS + 100)
  })

  test("an image on an otherwise-empty session does not trigger compaction", async () => {
    const model = createModel(ANTHROPIC_LIKE)
    const prepared = await Effect.runPromise(
      prepareRequest({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this screenshot?" },
              { type: "file", mediaType: "image/png", data: "A".repeat(1_000_000) },
            ],
          },
        ],
      }),
    )
    // Full window still available: nothing about one attachment shrinks it.
    expect(prepared.params.maxOutputTokens).toBe(64_000)
  })

  test("estimateInput counts the system prompt and tool schemas", () => {
    const messages = [{ role: "user" as const, content: "hi" }]
    const bare = estimateInput({ messages })
    const withSystem = estimateInput({ messages, system: ["s".repeat(40_000)] })
    const withTools = estimateInput({
      messages,
      tools: {
        big: {
          description: "d".repeat(4_000),
          inputSchema: jsonSchema({
            type: "object",
            properties: { q: { type: "string", description: "x".repeat(4_000) } },
          }),
        } as any,
      },
    })
    expect(withSystem - bare).toBeGreaterThan(9_000)
    expect(withTools - bare).toBeGreaterThan(1_900)
  })

  test("estimateInput treats a measured count as a lower bound", () => {
    const messages = [{ role: "user" as const, content: "hi" }]
    expect(estimateInput({ messages, measuredInputTokens: 120_000 })).toBe(120_000)
    expect(estimateInput({ messages, measuredInputTokens: 1 })).toBeGreaterThan(1)
  })

  test("thinkingBudget finds real budgets and ignores max_tokens", () => {
    expect(thinkingBudget({ anthropic: { thinking: { type: "enabled", budgetTokens: 16_000 } } })).toBe(16_000)
    expect(thinkingBudget({ thinking: { type: "enabled", budget_tokens: 31_999 } })).toBe(31_999)
    expect(thinkingBudget({ thinkingConfig: { includeThoughts: true, thinkingBudget: 8_000 } })).toBe(8_000)
    // A provider option literally named max_tokens is not a thinking budget.
    expect(thinkingBudget({ reasoning: { max_tokens: 8_000 } })).toBe(0)
    expect(thinkingBudget({ modelParams: { max_tokens: 4_000 } })).toBe(0)
    // Effort/adaptive reasoning has no numeric budget to find.
    expect(thinkingBudget({ thinking: { type: "adaptive" }, effort: "max" })).toBe(0)
    expect(thinkingBudget({ reasoning_effort: "high" })).toBe(0)
  })

  test("requested output clears a thinking budget by the text room", async () => {
    const model = createModel({
      ...ANTHROPIC_LIKE,
      variants: { max: { thinking: { type: "enabled", budgetTokens: 31_999 } } },
    })
    // Anthropic 400s when max_tokens <= thinking.budget_tokens.
    expect(
      requestedOutput({ model, estimatedInputTokens: 199_000, outputTokenMax: 64_000, thinkingBudget: 31_999 }),
    ).toBe(31_999 + 4_096)

    const prepared = await Effect.runPromise(
      prepareRequest({ model, messages: [{ role: "user", content: "x".repeat(4_000_000) }], variant: "max" }),
    )
    expect(prepared.params.maxOutputTokens).toBe(36_095)
    expect(prepared.params.maxOutputTokens!).toBeGreaterThan(31_999)
  })

  test("compaction.reserved is an exact trigger override on both branches", () => {
    const contextOnly = createModel(ANTHROPIC_LIKE)
    const withInput = createModel({ context: 200_000, input: 180_000, output: 64_000 })
    const cfg = cfgOf({ reserved: 10_000 })
    expect(usable({ cfg, model: contextOnly, outputTokenMax: 64_000 })).toBe(190_000)
    expect(usable({ cfg, model: withInput, outputTokenMax: 64_000 })).toBe(170_000)
  })

  test("compaction.output_floor sizes the window without triggering on its own", () => {
    const model = createModel(ANTHROPIC_LIKE)
    const cfg = cfgOf({ output_floor: 32_000 })
    expect(outputFloor({ model, outputTokenMax: 64_000, floor: 32_000 })).toBe(32_000)
    expect(usable({ cfg, model, outputTokenMax: 64_000 })).toBe(200_000 - 32_000 - 4_000)
    // Reserving more only moves the trigger earlier; it never shrinks a request
    // below what the remaining room supports.
    expect(requestedOutput({ model, estimatedInputTokens: 100_000, outputTokenMax: 64_000, floor: 32_000 })).toBe(
      64_000,
    )
  })

  test("dynamic_output:false restores the previous behavior exactly", async () => {
    const model = createModel(ANTHROPIC_LIKE)
    const cfg = cfgOf({ dynamic_output: false })
    // Old trigger: context - maxOutputTokens
    expect(usable({ cfg, model, outputTokenMax: 64_000 })).toBe(200_000 - 64_000)
    expect(requestedOutput({ model, estimatedInputTokens: 150_000, outputTokenMax: 64_000, dynamic: false })).toBe(
      64_000,
    )

    const prepared = await Effect.runPromise(
      prepareRequest({ model, messages: [{ role: "user", content: "x".repeat(600_000) }], cfg }),
    )
    expect(prepared.params.maxOutputTokens).toBe(64_000)
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 250_000, totalTokens: 1_000_000 }),
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test("uses authoritative Copilot billed cost when provided", () => {
    const result = SessionNs.getUsage({
      model: createModel({
        context: 100_000,
        output: 32_000,
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 0.3 } },
      }),
      usage: usage({ inputTokens: 11_774, outputTokens: 39, totalTokens: 11_813 }),
      metadata: { copilot: { totalNanoAiu: 4_473_525_000 } },
    })

    expect(result.cost).toBe(0.04473525)
  })

  test("uses matching context cost tier before over-200k fallback", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 3,
            output: 4,
            cache: { read: 0.3, write: 1.5 },
            tier: { type: "context", size: 200_000 },
          },
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 100,
          output: 100,
          cache: { read: 100, write: 100 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({
        inputTokens: 650_000,
        outputTokens: 100_000,
        totalTokens: 750_000,
        cacheReadInputTokens: 100_000,
      }),
    })

    expect(result.tokens.input).toBe(550_000)
    expect(result.cost).toBe(2.75 + 0.6 + 0.05)
  })

  test("falls back to over-200k pricing when no cost tier matches", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 3,
          output: 4,
          cache: { read: 0.3, write: 1.5 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000 }),
    })

    expect(result.cost).toBe(0.9 + 0.4)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const item = usage({
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 200,
      })
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = SessionNs.getUsage({
          model,
          usage: item,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = SessionNs.getUsage({
        model,
        usage: item,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})
