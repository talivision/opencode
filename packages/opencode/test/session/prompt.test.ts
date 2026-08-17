import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionGoal } from "../../src/session/goal"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"

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

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  SessionGoal.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

type PromptLayerInput = {
  mcpInstructions?: MCP.ServerInstructions[]
  processor?: "blocking"
  goalReviewTimeoutMs?: number
  goalReviewMaxMs?: number
}

function flagsFor(input?: PromptLayerInput) {
  if (!input?.goalReviewTimeoutMs && !input?.goalReviewMaxMs) return runtimeFlags
  return RuntimeFlags.layer({
    experimentalEventSystem: true,
    ...(input.goalReviewTimeoutMs ? { goalReviewTimeoutMs: input.goalReviewTimeoutMs } : {}),
    ...(input.goalReviewMaxMs ? { goalReviewMaxMs: input.goalReviewMaxMs } : {}),
  })
}

function makePrompt(input?: PromptLayerInput) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, flagsFor(input)],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: PromptLayerInput) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, flagsFor(input)],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: PromptLayerInput) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const reviewerTimeout = testEffect(makeHttp({ goalReviewTimeoutMs: 100 }))
const reviewerPaced = testEffect(makeHttp({ goalReviewTimeoutMs: 400 }))
// Generous inactivity window, tiny hard cap: only the total-duration limit can fire.
const reviewerHardCap = testEffect(makeHttp({ goalReviewTimeoutMs: 60_000, goalReviewMaxMs: 900 }))
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

// providerCfg plus goal review limits, for exercising the config fallback and
// its precedence against OPENCODE_GOAL_REVIEW_* (modelled by RuntimeFlags).
function goalReviewCfg(review: { timeout?: number; max_duration?: number }) {
  return (url: string) => ({ ...providerCfg(url), goal: { review } })
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("active goals are independently reviewed only after completion claims until accepted", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal continuation",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the durable goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "continue once, then finish" })
    yield* llm.push(
      reply()
        .text("First increment complete.")
        .tool("goal", { status: "complete", reason: "first increment evidence" })
        .usage({ input: 20, output: 5 }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom((hit) => {
      const input = JSON.stringify(hit.body)
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(input)?.[1]
      return `VERDICT: NOT_MET ${nonce} another increment is still required`
    })
    yield* llm.tool("goal", { status: "complete" })
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom(
      (hit) => {
        const input = JSON.stringify(hit.body)
        const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(input)?.[1]
        return `Independent checks passed.\nVERDICT: MET ${nonce} objective verified`
      },
      { usage: { input: 12_000, output: 58 } },
    )

    const result = yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    const messages = yield* sessions.messages({ sessionID: session.id })
    expect(yield* llm.calls).toBe(6)
    expect(goal?.status).toBe("complete")
    expect(goal?.review?.status).toBe("accepted")
    expect(goal?.turns).toBe(2)
    // Goal accounting mirrors Claude: generated worker + reviewer tokens, never prompt/cache context.
    expect(goal?.tokensUsed).toBe(63)
    expect(result.info.role).toBe("assistant")
    const reviewParts = messages.flatMap((message) =>
      message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "goal-review"),
    )
    expect(reviewParts).toHaveLength(2)
    expect(reviewParts[0]?.state.status === "completed" ? reviewParts[0].state.metadata.verdict : "error").toBe(
      "rejected",
    )
    expect(reviewParts[1]?.state.status).toBe("completed")
    expect(reviewParts[1]?.state.status === "completed" ? reviewParts[1].state.metadata : {}).toMatchObject({
      verdict: "accepted",
      tokens: 58,
    })
    expect(reviewParts[1]?.state.status === "completed" ? reviewParts[1].state.output : "").toContain(
      "objective verified",
    )

    const inputs = yield* llm.inputs
    expect(JSON.stringify(inputs[0])).toContain("<active-goal>")
    expect(JSON.stringify(inputs[0])).toContain("continue once, then finish")
    // The reviewer is seeded with an index of the parent session, not the
    // parent session itself.
    expect(JSON.stringify(inputs[2])).not.toContain("<parent-session-transcript>")
    expect(JSON.stringify(inputs[2])).toContain("<parent-session-index>")
    expect(JSON.stringify(inputs[2])).toContain("First increment complete.")
    expect(JSON.stringify(inputs[2])).toContain("<goal-requirements>")

    const reviewers = yield* sessions.children(session.id)
    expect(reviewers).toHaveLength(2)
    expect(reviewers.every((reviewer) => reviewer.metadata?.goalReviewer)).toBe(true)
    expect(reviewers.map((reviewer) => reviewer.title)).toEqual(
      expect.arrayContaining([expect.stringContaining("rejected"), expect.stringContaining("accepted")]),
    )
  }),
)

it.instance("active goal requests keep the joined system message byte-identical across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal system cache stability",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "continue after one provider failure" }],
    })
    yield* goals.set({
      sessionID: session.id,
      objective: "keep the active goal system prefix stable",
      tokenBudget: 1,
    })
    yield* llm.error(400, { error: { message: "first request failed" } })
    yield* llm.text("Recovered.", { usage: { input: 10, output: 1 } })

    yield* prompt.loop({ sessionID: session.id })

    const systems = (yield* llm.hits).map((hit) => {
      if (!Array.isArray(hit.body.messages)) throw new Error("expected request messages")
      const system = hit.body.messages.filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null && message.role === "system",
      )
      expect(system).toHaveLength(1)
      if (typeof system[0]?.content !== "string") throw new Error("expected joined system message")
      return system[0].content
    })
    expect(systems).toHaveLength(2)
    expect(systems[0]).toBe(systems[1])
  }),
)

it.instance("a rejected completion review keeps the goal active until a later review accepts it", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal review rejection",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "verify the goal before accepting completion" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "produce authoritative verification evidence" })
    yield* llm.tool("goal", { status: "complete", reason: "unverified worker claim" })
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom((hit) => {
      const input = JSON.stringify(hit.body)
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(input)?.[1]
      return `VERDICT: NOT_MET ${nonce} authoritative evidence is missing`
    })
    yield* llm.tool("goal", { status: "complete", reason: "authoritative evidence gathered" })
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom((hit) => {
      const input = JSON.stringify(hit.body)
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(input)?.[1]
      return `VERDICT: MET ${nonce} authoritative evidence was independently verified`
    })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    expect(goal?.status).toBe("complete")
    expect(goal?.review?.status).toBe("accepted")
    expect(goal?.review?.attempt).toBe(2)

    const inputs = yield* llm.inputs
    expect(JSON.stringify(inputs)).toContain("authoritative evidence is missing")

    const reviewers = yield* sessions.children(session.id)
    expect(reviewers).toHaveLength(2)
    expect(reviewers.map((reviewer) => reviewer.title)).toEqual(
      expect.arrayContaining([expect.stringContaining("rejected"), expect.stringContaining("accepted")]),
    )
    const messages = yield* sessions.messages({ sessionID: session.id })
    const reviewParts = messages.flatMap((message) =>
      message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "goal-review"),
    )
    expect(reviewParts).toHaveLength(2)
    expect(
      reviewParts.map((part) => (part.state.status === "completed" ? part.state.metadata.verdict : "error")),
    ).toEqual(["rejected", "accepted"])
  }),
)

it.instance("an accepted review after a continuation ends the run without one more worker turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal accept after continuation",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "work the goal until the reviewer accepts" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "stop the moment the reviewer accepts" })
    yield* llm.push(
      reply()
        .text("First increment done.")
        .tool("goal", { status: "complete", reason: "first increment evidence" })
        .usage({ input: 20, output: 5 }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom((hit) => {
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
      return `VERDICT: NOT_MET ${nonce} one more increment is required`
    })
    yield* llm.push(
      reply()
        .text("Second increment done.")
        .tool("goal", { status: "complete", reason: "second increment evidence" })
        .usage({ input: 20, output: 5 }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom((hit) => {
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
      return `VERDICT: MET ${nonce} objective independently verified`
    })

    yield* prompt.loop({ sessionID: session.id })

    const goal = yield* goals.get(session.id)
    expect(goal?.status).toBe("complete")
    expect(goal?.review?.status).toBe("accepted")
    // Two worker turns, each with a claim step and the protocol-required
    // follow-up, plus two reviews. A seventh request here means the accepted
    // goal re-sent the already-answered continuation.
    expect(yield* llm.calls).toBe(6)
    expect(yield* llm.pending).toBe(0)
    // The accepting review is the last thing that talks to the provider.
    const inputs = yield* llm.inputs
    expect(JSON.stringify(inputs.at(-1))).toContain("<parent-session-index>")
    // Every request after the continuation carries it in its history, so count
    // continuation USER MESSAGES in the last worker request's transcript
    // rather than counting requests: two messages there means the accepted
    // goal re-sent the already-answered continuation.
    const workerInputs = inputs.filter((input) =>
      JSON.stringify(input).includes("Continue working toward the active goal"),
    )
    expect(workerInputs.length).toBeGreaterThan(0)
    const lastWorker = workerInputs.at(-1) as { messages?: { role?: string; content?: unknown }[] }
    expect(
      (lastWorker.messages ?? []).filter(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content ?? "").includes("Continue working toward the active goal"),
      ),
    ).toHaveLength(1)
    // Only real working turns are counted.
    expect(goal?.turns).toBe(2)

    const messages = yield* sessions.messages({ sessionID: session.id })
    expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(4)
  }),
)

it.instance("reviewers index the parent session, retrieve on demand, and hand conclusions to the next attempt", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal reviewer retrieval",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the retrieval goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "say lima and prove it twice" })

    const flat = (hit: { body: unknown }) => JSON.stringify(hit.body)
    const isReviewer = (hit: { body: unknown }) => flat(hit).includes("verdict nonce for this review is")
    const isWorker = (hit: { body: unknown }) => !isReviewer(hit)
    // Attempts are told apart by which checklist block their seed carries.
    const first = (hit: { body: unknown }) =>
      isReviewer(hit) && flat(hit).includes("No requirement checklist has been recorded")
    const second = (hit: { body: unknown }) =>
      isReviewer(hit) && flat(hit).includes("Earlier reviewers recorded this checklist")
    const saw = (hit: { body: unknown }, value: string) => flat(hit).includes(value)

    yield* llm.toolMatch(isWorker, "goal", { status: "complete", reason: "lima was said once" })
    yield* llm.textMatch(isWorker, "Claim submitted; awaiting review.")
    yield* llm.pushMatch(
      isWorker,
      reply().text("Second proof added.").tool("goal", { status: "complete", reason: "both proofs are present" }),
    )
    yield* llm.textMatch(isWorker, "Claim submitted; awaiting review.")

    yield* llm.toolMatch((hit) => first(hit) && !saw(hit, "Checklist recorded"), "goal_checklist", {
      requirements: [
        { id: "R1", text: "say lima" },
        { id: "R2", text: "prove it twice" },
      ],
    })
    yield* llm.toolMatch(
      (hit) => first(hit) && saw(hit, "Checklist recorded") && !saw(hit, "untrusted-parent-transcript"),
      "goal_transcript",
      { mode: "search", query: "lima" },
    )
    yield* llm.toolMatch(
      (hit) => first(hit) && saw(hit, "untrusted-parent-transcript") && !saw(hit, "Verdict recorded"),
      "goal_verdict",
      {
        met: false,
        summary: "only one proof is present",
        unmet: [{ requirement: "prove it twice", evidence: "only one proof in the worker session" }],
        requirements: [
          { id: "R1", status: "met", evidence: "lima appears in the worker session" },
          { id: "R2", status: "unmet", evidence: "only one proof was retrieved" },
        ],
      },
    )
    yield* llm.textMatch((hit) => first(hit) && saw(hit, "Verdict recorded"), "Verdict submitted.", {
      usage: { input: 5_000, output: 7 },
    })

    yield* llm.toolMatch((hit) => second(hit) && !saw(hit, "Verdict recorded"), "goal_verdict", {
      met: true,
      summary: "both proofs verified against current state",
      requirements: [
        { id: "R1", status: "met", evidence: "still present" },
        { id: "R2", status: "met", evidence: "the second proof is now present" },
      ],
    })
    yield* llm.textMatch((hit) => second(hit) && saw(hit, "Verdict recorded"), "Verdict submitted.", {
      usage: { input: 6_000, output: 9 },
    })

    yield* prompt.loop({ sessionID: session.id })

    const goal = yield* goals.get(session.id)
    expect(goal?.status).toBe("complete")
    expect(goal?.review?.status).toBe("accepted")
    expect(goal?.review?.attempt).toBe(2)
    // Conclusions carry across attempts, sessions do not.
    expect(goal?.requirements).toMatchObject([
      { id: "R1", text: "say lima", status: "met", attempt: 2 },
      { id: "R2", text: "prove it twice", status: "met", attempt: 2 },
    ])

    const stats = goal?.review?.attemptStats ?? []
    expect(stats.map((entry) => entry.attempt)).toEqual([1, 2])
    // The first reviewer retrieved once; the second never needed to.
    expect(stats[0]?.retrievalCalls).toBe(1)
    expect(stats[1]?.retrievalCalls).toBe(0)
    expect(stats[0]?.inputTokens).toBeGreaterThan(0)
    expect(stats[1]?.outputTokens).toBeGreaterThan(0)

    // A fresh reviewer session per attempt: a reused reviewer would re-send its
    // own stale retrieval output every step.
    const reviewers = yield* sessions.children(session.id)
    expect(reviewers).toHaveLength(2)

    const bodies = (yield* llm.inputs).map((body) => JSON.stringify(body))
    const reviewerBodies = bodies.filter((body) => body.includes("verdict nonce for this review is"))
    expect(reviewerBodies.length).toBeGreaterThanOrEqual(6)
    expect(reviewerBodies[0]).toContain("<parent-session-index>")
    expect(reviewerBodies[0]).toContain("No requirement checklist has been recorded")
    // The seed is an index, not the transcript: no worker tool output in it.
    expect(reviewerBodies[0]).not.toContain("Completion is pending independent review")
    const last = reviewerBodies.at(-1)!
    expect(last).toContain("Earlier reviewers recorded this checklist")
    expect(last).toContain("R2 [unmet, attempt 1] prove it twice")
    expect(last).toContain("prior evidence: only one proof was retrieved")
    expect(last).not.toContain("Completion is pending independent review")
  }),
)

it.instance("an interrupted running review is recovered and independently retried", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const run = yield* SessionRunState.Service
    const session = yield* sessions.create({
      title: "Interrupted goal review",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "resume after a process interruption" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "recover the interrupted independent review" })
    yield* goals.requestReview({ sessionID: session.id, evidence: "verified before interruption" })
    const orphan = yield* sessions.create({
      parentID: session.id,
      title: "[goal-reviewer] interrupted",
      metadata: { goalReviewer: true },
    })
    yield* goals.beginReview(session.id, orphan.id)
    const orphanFiber = yield* run.ensureRunning(orphan.id, Effect.interrupt, Effect.never).pipe(Effect.forkChild)
    yield* pollWithTimeout(
      run.assertNotBusy(orphan.id).pipe(
        Effect.exit,
        Effect.map((exit) => (Exit.isFailure(exit) ? true : undefined)),
      ),
      "interrupted reviewer never became busy",
    )

    yield* llm.text("Worker turn after restart.")
    yield* llm.textFrom((hit) => {
      const input = JSON.stringify(hit.body)
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(input)?.[1]
      return `VERDICT: MET ${nonce} recovered review verified the objective`
    })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    expect(goal?.status).toBe("complete")
    expect(goal?.review?.status).toBe("accepted")
    expect(goal?.review?.attempt).toBe(1)
    const preserved = yield* sessions.get(orphan.id)
    expect(preserved.title).toContain("interrupted")
    expect((yield* status.get(orphan.id)).type).toBe("idle")
    yield* run.assertNotBusy(orphan.id)
    expect(Exit.isFailure(yield* Fiber.await(orphanFiber))).toBe(true)
    const reviewers = yield* sessions.children(session.id)
    expect(reviewers).toHaveLength(2)
    expect(reviewers.some((reviewer) => reviewer.title.includes("accepted"))).toBe(true)
  }),
)

reviewerTimeout.instance("a hanging reviewer times out, remains inspectable, and returns control", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const run = yield* SessionRunState.Service
    const session = yield* sessions.create({
      title: "Goal reviewer watchdog",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the lima goal" }],
    })
    yield* goals.set({
      sessionID: session.id,
      objective:
        "Speak the word lima and return control. The reviewer should force continued lima turns without hanging.",
      tokenBudget: 1,
    })
    yield* llm.tool("goal", { status: "complete", reason: "lima was spoken" })
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.hang
    yield* llm.text("Worker resumed after the reviewer timeout.", { usage: { input: 10, output: 1 } })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    expect(goal?.status).toBe("paused")
    expect(goal?.pauseReason).toBe("budget")
    expect(goal?.review?.status).toBe("error")
    expect(goal?.review?.reason).toContain("timed out")

    const reviewers = yield* sessions.children(session.id)
    expect(reviewers).toHaveLength(1)
    expect(reviewers[0]?.title).toContain("timed out")
    expect((yield* status.get(reviewers[0]!.id)).type).toBe("idle")
    yield* run.assertNotBusy(reviewers[0]!.id)
    const messages = yield* sessions.messages({ sessionID: session.id })
    const reviewPart = messages
      .flatMap((message) => message.parts)
      .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "goal-review")
    expect(reviewPart?.state.status).toBe("error")
    expect(reviewPart?.state.status === "error" ? reviewPart.state.error : "").toContain("without activity")
  }),
)

// The reviewer's only remaining prompt path: everything outside the worktree is
// readable without a human except the enumerated credential stores, which stay
// "ask". A pending ask is a real, reachable state, not a synthetic one, and this
// probe path is never expected to exist on any machine.
const credentialProbe = path.join(os.homedir(), ".password-store", "opencode-goal-review-probe")

// Poll for the pending permission raised by whichever reviewer child session the
// goal loop created.
const pendingForReviewer = (sessionID: SessionID) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const children = new Set((yield* sessions.children(sessionID)).map((child) => child.id))
      return (yield* permission.list()).find((request) => children.has(request.sessionID))
    }),
    "reviewer never raised a permission request",
    "10 seconds",
  )

reviewerTimeout.instance("a reviewer blocked on an unanswered permission is not killed for inactivity", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const session = yield* sessions.create({
      title: "Goal reviewer waiting on a human",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the away-from-keyboard goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "verify a reviewer that stops on a human, not on a stall" })
    yield* llm.tool("goal", { status: "complete", reason: "worker claims completion" })
    yield* llm.text("Claim submitted; awaiting review.")
    // The reviewer's first act blocks on a permission nobody is there to answer.
    yield* llm.tool("read", { filePath: credentialProbe })
    yield* llm.textFrom((hit) => {
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
      return `VERDICT: MET ${nonce} verified once the human answered`
    })
    // Safety net so a regression fails an assertion instead of hanging the loop.
    yield* llm.text("Follow-up worker turn.")
    yield* llm.textFrom((hit) => {
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
      return `VERDICT: MET ${nonce} second attempt`
    })

    const fiber = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
    const request = yield* pendingForReviewer(session.id)

    // Sit on the prompt for many multiples of the 100ms inactivity window. The
    // pre-fix watchdog killed the review on the first tick past 100ms.
    yield* Effect.sleep("1200 millis")
    const during = yield* goals.get(session.id)
    expect(during?.review?.status).toBe("running")
    const waiting = yield* sessions.messages({ sessionID: session.id })
    const waitingPart = waiting
      .flatMap((message) => message.parts)
      .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "goal-review")
    expect(waitingPart?.state.status).toBe("running")
    // The indefinite wait is legible rather than silent.
    expect(waitingPart?.state.status === "running" ? waitingPart.state.metadata?.["activity"] : undefined).toBe(
      "Waiting for permission approval",
    )

    yield* permission.reply({ requestID: request.id, reply: "once" })
    yield* awaitWithTimeout(
      Fiber.join(fiber),
      "goal loop never finished after the permission was answered",
      "20 seconds",
    )

    const goal = yield* goals.get(session.id)
    expect(goal?.review?.status).toBe("accepted")
    expect(goal?.status).toBe("complete")
    // A killed reviewer would have forced a second attempt.
    expect(goal?.review?.attempt).toBe(1)
    expect(goal?.review?.reason).toContain("verified once the human answered")
    expect(yield* sessions.children(session.id)).toHaveLength(1)
  }),
)

reviewerTimeout.instance("the inactivity timer resumes once the permission is answered", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const session = yield* sessions.create({
      title: "Goal reviewer resumes after the answer",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the answered-then-stalled goal" }],
    })
    yield* goals.set({
      sessionID: session.id,
      objective: "verify the inactivity window is suspended, not disabled",
      tokenBudget: 1,
    })
    yield* llm.tool("goal", { status: "complete", reason: "worker claims completion" })
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.tool("read", { filePath: credentialProbe })
    // Answered, then genuinely stalls: the suspended window has to start ticking
    // again, otherwise one permission would buy immunity for the whole review.
    yield* llm.hang
    yield* llm.text("Worker resumed after the reviewer timeout.", { usage: { input: 10, output: 1 } })

    const fiber = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
    const request = yield* pendingForReviewer(session.id)
    yield* Effect.sleep("600 millis")
    expect((yield* goals.get(session.id))?.review?.status).toBe("running")

    yield* permission.reply({ requestID: request.id, reply: "once" })
    yield* awaitWithTimeout(Fiber.join(fiber), "goal loop never finished after the reviewer stalled", "20 seconds")

    const goal = yield* goals.get(session.id)
    expect(goal?.review?.status).toBe("error")
    expect(goal?.review?.reason).toContain("without activity")
    const reviewers = yield* sessions.children(session.id)
    expect(reviewers[0]?.title).toContain("timed out")
  }),
)

it.instance("goal review limits fall back to config when the env override is unset", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(goalReviewCfg({ timeout: 100 }))
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal reviewer config timeout",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the configured goal" }],
    })
    yield* goals.set({
      sessionID: session.id,
      objective: "verify that a config-supplied inactivity limit is honoured",
      tokenBudget: 1,
    })
    yield* llm.tool("goal", { status: "complete", reason: "worker claims completion" })
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.hang
    yield* llm.text("Worker resumed after the reviewer timeout.", { usage: { input: 10, output: 1 } })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    // Without the config fallback this reviewer would hang until the 120s default.
    expect(goal?.review?.status).toBe("error")
    expect(goal?.review?.reason).toContain("without activity")
  }),
)

reviewerTimeout.instance("the goal review env override wins over config", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(goalReviewCfg({ timeout: 3_600_000, max_duration: 3_600_000 }))
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal reviewer env precedence",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the overridden goal" }],
    })
    yield* goals.set({
      sessionID: session.id,
      objective: "verify that the env override beats a permissive config",
      tokenBudget: 1,
    })
    yield* llm.tool("goal", { status: "complete", reason: "worker claims completion" })
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.hang
    yield* llm.text("Worker resumed after the reviewer timeout.", { usage: { input: 10, output: 1 } })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    // The 100ms flag must win; the hour-long config value would stall the suite.
    expect(goal?.review?.status).toBe("error")
    expect(goal?.review?.reason).toContain("without activity")
  }),
)

reviewerHardCap.instance("a reviewer that stays busy is stopped by the total-duration safety limit", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal reviewer hard cap",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the endless goal" }],
    })
    yield* goals.set({
      sessionID: session.id,
      objective: "verify that a busy but non-converging reviewer is capped",
      tokenBudget: 1,
    })
    yield* llm.tool("goal", { status: "complete", reason: "worker claims completion" })
    yield* llm.text("Claim submitted; awaiting review.")
    // Never emits a verdict, but never goes quiet either, so the inactivity
    // watchdog keeps being reset and only the hard cap can stop it.
    yield* llm.textChunksFrom(() => Array.from({ length: 200 }, (_, index) => `still working ${index}\n`), {
      pace: 30,
      usage: { input: 12_000, output: 200 },
    })
    yield* llm.text("Worker resumed after the reviewer hit the cap.", { usage: { input: 10, output: 1 } })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    expect(goal?.review?.status).toBe("error")
    // Sub-minute caps must report seconds, not a rounded-up "1 minute".
    expect(goal?.review?.reason).toContain("1 second safety limit")
    expect(goal?.review?.reason).not.toContain("without activity")
  }),
)

reviewerPaced.instance(
  "a reviewer that keeps streaming is never killed by the inactivity watchdog and reports live progress",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const goals = yield* SessionGoal.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Paced goal reviewer",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "start the paced goal" }],
      })
      yield* goals.set({ sessionID: session.id, objective: "verify a slow but continuously active reviewer" })
      yield* llm.tool("goal", { status: "complete", reason: "worker claims completion" })
      yield* llm.text("Claim submitted; awaiting review.")
      // Streams for ~6x the inactivity window, but never stops producing output.
      // Text deltas are broadcast as part deltas and only land in the part row at
      // text-end, so a poll-only watchdog sees this reviewer as idle and kills it.
      yield* llm.textChunksFrom(
        (hit) => {
          const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
          return [
            "Reading the repository state\n",
            "Comparing against every explicit requirement\n",
            "Re-running the authoritative check\n",
            "Confirming there is no remaining work\n",
            "Writing up the decisive evidence\n",
            `VERDICT: MET ${nonce} continuously active reviewer verified the objective`,
          ]
        },
        { pace: 120, usage: { input: 12_000, output: 58 } },
      )

      // Safety net so a regression fails an assertion instead of hanging the loop.
      yield* llm.text("Follow-up worker turn.")
      yield* llm.textFrom((hit) => {
        const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
        return `VERDICT: MET ${nonce} second attempt`
      })

      yield* prompt.loop({ sessionID: session.id })
      const goal = yield* goals.get(session.id)
      expect(goal?.review?.status).toBe("accepted")
      expect(goal?.status).toBe("complete")
      // A killed reviewer would force a second attempt.
      expect(goal?.review?.attempt).toBe(1)
      expect(goal?.review?.reason).toContain("continuously active reviewer")

      const messages = yield* sessions.messages({ sessionID: session.id })
      const reviewPart = messages
        .flatMap((message) => message.parts)
        .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "goal-review")
      expect(reviewPart?.state.status).toBe("completed")
      expect(reviewPart?.state.status === "completed" ? reviewPart.state.metadata : {}).toMatchObject({
        verdict: "accepted",
        tokens: 58,
      })
    }),
)

it.instance("goal continuation backoff doubles from the second consecutive failure and caps at 5 minutes", () =>
  Effect.sync(() => {
    // First failure continues immediately: the in-turn retry policy already
    // backed off before the turn died.
    expect(SessionPrompt.goalContinueBackoffMs(0)).toBe(0)
    expect(SessionPrompt.goalContinueBackoffMs(1)).toBe(0)
    expect(SessionPrompt.goalContinueBackoffMs(2)).toBe(5_000)
    expect(SessionPrompt.goalContinueBackoffMs(3)).toBe(10_000)
    expect(SessionPrompt.goalContinueBackoffMs(4)).toBe(20_000)
    expect(SessionPrompt.goalContinueBackoffMs(8)).toBe(300_000)
    expect(SessionPrompt.goalContinueBackoffMs(100)).toBe(300_000)
  }),
)

it.instance("a goal turn that dies on a provider error is never handed to the reviewer", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal provider failure",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the flaky goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "keep going across a provider failure", tokenBudget: 1 })
    // The turn dies without the model ever claiming completion. Non-retryable
    // (4xx, not marked retryable) so the retry policy gives up immediately.
    yield* llm.error(400, { error: { message: "provider exploded" } })
    // Second turn succeeds and exhausts the budget, ending the loop.
    yield* llm.text("Recovered.", { usage: { input: 10, output: 4 } })

    yield* prompt.loop({ sessionID: session.id })

    // The decisive assertion: no reviewer child session was ever created. Before
    // this fix the errored turn spawned one against the provider that just failed.
    expect(yield* sessions.children(session.id)).toHaveLength(0)
    const goal = yield* goals.get(session.id)
    expect(goal?.review).toBeUndefined()
    const inputs = yield* llm.inputs
    expect(JSON.stringify(inputs[1])).toContain("Current active-goal status for this turn:")
    expect(JSON.stringify(inputs[1])).toContain("Consecutive interrupted goal turns: 1")
    expect(JSON.stringify(inputs[1])).toContain(
      "The previous turn ended before you completed it (provider exploded). Resume from current state",
    )
  }),
)

it.instance(
  "a second consecutive provider failure delays the next goal turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const goals = yield* SessionGoal.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Goal backoff",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "start the outage goal" }],
      })
      yield* goals.set({ sessionID: session.id, objective: "outlast a provider outage", tokenBudget: 1 })
      yield* llm.error(400, { error: { message: "provider exploded" } })
      yield* llm.error(400, { error: { message: "provider exploded" } })
      yield* llm.text("Recovered.", { usage: { input: 10, output: 4 } })

      const startedAt = Date.now()
      yield* prompt.loop({ sessionID: session.id })

      // Second consecutive failure must wait goalContinueBackoffMs(2) = 5s before
      // the third turn; the first failure continues immediately.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_000)
      const goal = yield* goals.get(session.id)
      expect(goal?.turns).toBe(3)
      expect(goal?.interrupted).toBeUndefined()
      expect(yield* sessions.children(session.id)).toHaveLength(0)
    }),
  15_000,
)

it.instance("an unclaimed goal turn persists a reminder without spawning a reviewer", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal unclaimed reminder",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "continue the goal without claiming completion" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "keep working until explicitly complete" })
    yield* llm.text("I stopped without using the goal tool.")
    yield* llm.hang

    const fiber = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
    yield* awaitWithTimeout(llm.wait(2), "timed out waiting for reminder continuation", "10 seconds")

    const goal = yield* goals.get(session.id)
    const messages = yield* sessions.messages({ sessionID: session.id })
    const reminder = messages.find(
      (message) =>
        message.info.role === "user" &&
        message.parts.some(
          (part) =>
            part.type === "text" &&
            part.synthetic === true &&
            part.text.includes("Your turn ended without calling the goal tool"),
        ),
    )
    expect(goal?.review).toBeUndefined()
    expect(goal?.reminderStreak).toBe(1)
    expect(reminder).toBeDefined()
    expect(yield* sessions.children(session.id)).toHaveLength(0)
    yield* Fiber.interrupt(fiber)
  }),
)

it.instance("a running background child defers pending review and goal continuation", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const session = yield* sessions.create({
      title: "Goal waiting for background child",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "wait for the background child" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "incorporate the background child's result" })
    yield* goals.requestReview({ sessionID: session.id, evidence: "premature completion claim" })
    const job = yield* background.start({
      id: "goal-running-child",
      type: "task",
      metadata: { parentSessionId: session.id },
      run: Effect.never,
    })
    yield* Effect.addFinalizer(() => background.cancel(job.id).pipe(Effect.ignore))
    yield* llm.text("Waiting for the child notification.")

    yield* prompt.loop({ sessionID: session.id })

    const goal = yield* goals.get(session.id)
    const messages = yield* sessions.messages({ sessionID: session.id })
    expect(goal?.review?.status).toBe("pending")
    expect(goal?.reminderStreak).toBe(0)
    expect(yield* sessions.children(session.id)).toHaveLength(0)
    expect(
      messages.some(
        (message) =>
          message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.synthetic === true),
      ),
    ).toBe(false)
  }),
)

it.instance("the reviewer accepts through the goal_verdict tool without a nonce line", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal verdict tool accept",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the structured goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "say lima once and return control" })
    yield* llm.push(
      reply()
        .text("Lima")
        .tool("goal", { status: "complete", reason: "lima appears in the worker response" })
        .usage({ input: 9_000, output: 4 }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    // Reviewer submits through the tool; its closing text has NO nonce line, so
    // acceptance can only have come from the structured verdict.
    yield* llm.tool("goal_verdict", { met: true, summary: "verified by structured tool verdict" })
    yield* llm.text("Review finished.", { usage: { input: 100, output: 5 } })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    expect(goal?.status).toBe("complete")
    expect(goal?.review?.status).toBe("accepted")
    expect(goal?.review?.reason).toContain("verified by structured tool verdict")
    expect(goal?.review?.verdict?.met).toBe(true)
  }),
)

it.instance("a contradictory verdict is refused and the corrected retry is the one recorded", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal verdict contradiction",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the contradictory goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "say lima once" })
    yield* llm.push(
      reply()
        .text("Lima")
        .tool("goal", { status: "complete", reason: "lima appears in the worker response" })
        .usage({ input: 9_000, output: 4 }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    // met:true with unmet items must be refused by the tool, not recorded.
    yield* llm.tool("goal_verdict", {
      met: true,
      summary: "claims met",
      unmet: [{ requirement: "say lima once", evidence: "lima is missing" }],
    })
    // The reviewer corrects itself after the tool's error output.
    yield* llm.tool("goal_verdict", { met: true, summary: "corrected verdict after contradiction" })
    yield* llm.text("Review finished.", { usage: { input: 100, output: 5 } })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    expect(goal?.status).toBe("complete")
    expect(goal?.review?.verdict?.summary).toBe("corrected verdict after contradiction")
  }),
)

it.instance("a structured rejection feeds unmet requirements into the continuation message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal verdict tool reject",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the rejected goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "say lima twice" })
    yield* llm.push(
      reply()
        .text("Lima")
        .tool("goal", { status: "complete", reason: "one lima appears in the worker response" })
        .usage({ input: 9_000, output: 4 }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    // Review #1: structured rejection with a concrete unmet requirement.
    yield* llm.tool("goal_verdict", {
      met: false,
      summary: "objective not yet satisfied",
      unmet: [{ requirement: "say lima twice", evidence: "only one lima appears in the transcript" }],
    })
    yield* llm.text("Review finished.", { usage: { input: 100, output: 5 } })
    // Worker continuation turn; capture what the model was actually sent.
    yield* llm.push(
      reply().text("Lima").tool("goal", { status: "complete", reason: "both limas now appear in the transcript" }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    // Review #2 accepts.
    yield* llm.tool("goal_verdict", { met: true, summary: "both limas verified" })
    yield* llm.text("Review finished.", { usage: { input: 100, output: 5 } })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    const inputs = yield* llm.inputs
    const worker = inputs.find(
      (input) =>
        JSON.stringify(input).includes("only one lima appears in the transcript") &&
        !JSON.stringify(input).includes("<parent-session-index>"),
    ) as { messages?: { role: string; content: unknown }[]; tools?: unknown } | undefined
    const continuation = JSON.stringify(worker?.messages?.filter((message) => message.role === "user") ?? [])
    const workerTools = JSON.stringify(worker?.tools ?? [])
    expect(goal?.status).toBe("complete")
    expect(goal?.review?.attempt).toBe(2)
    // The rejection reached the worker as conversation content, verbatim.
    expect(continuation).toContain("Current active-goal status for this turn:")
    expect(continuation).toMatch(/Elapsed: .* across 1 completed goal turn\(s\)\./)
    expect(continuation).toContain("Token budget: 9 used; no total was set.")
    expect(continuation).toContain("Independent review attempt 1 did not accept completion")
    expect(continuation).toContain("rejected completion attempt #1")
    expect(continuation).toContain("only one lima appears in the transcript")
    // The worker must never see the reviewer's verdict tool.
    expect(workerTools).not.toContain("goal_verdict")
    // History carried the rejection across the attempt boundary.
    expect(goal?.review?.history?.length).toBe(1)
    expect(goal?.review?.history?.[0]?.reason).toContain("say lima twice")
  }),
)

it.instance("a multi-step worker turn counts as one goal turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal turn accounting",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the multi-step goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "use two tools, then answer once" })
    // One user-visible turn: two tool rounds, then the final text that returns
    // control. Each round is a separate provider request, but the goal turn
    // counter must see exactly one turn — otherwise "three consecutive goal
    // turns" is reachable inside a single worker turn.
    yield* llm.tool("glob", { pattern: "*" })
    yield* llm.tool("glob", { pattern: "**/*.json" })
    yield* llm.push(
      reply()
        .text("Done")
        .tool("goal", { status: "complete", reason: "both glob calls completed" })
        .usage({ input: 9_000, output: 4 }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom((hit) => {
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
      return `VERDICT: MET ${nonce} both tools ran and control returned`
    })

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    expect(goal?.turns).toBe(1)
    expect(goal?.status).toBe("complete")
  }),
)

it.instance("goal accounting counts only generated worker and reviewer tokens", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal token accounting",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the accounting goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "say lima once and return control" })
    yield* llm.push(
      reply()
        .text("Lima")
        .tool("goal", { status: "complete", reason: "lima was spoken once" })
        .usage({ input: 9_000, output: 4 }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom(
      (hit) => {
        const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
        return `VERDICT: MET ${nonce} lima was spoken once and control returned`
      },
      { usage: { input: 12_000, output: 58 } },
    )

    yield* prompt.loop({ sessionID: session.id })
    const goal = yield* goals.get(session.id)
    // 4 generated worker tokens + 58 generated reviewer tokens. The 9,000 and
    // 12,000 prompt/context tokens must never be counted against the goal.
    expect(goal?.tokensUsed).toBe(62)
    expect(goal?.status).toBe("complete")

    const messages = yield* sessions.messages({ sessionID: session.id })
    const reviewPart = messages
      .flatMap((message) => message.parts)
      .find((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "goal-review")
    expect(reviewPart?.state.status === "completed" ? reviewPart.state.metadata.tokens : 0).toBe(58)
  }),
)

it.instance("worker model context never advertises the hidden reviewer agent or the goal-review tool", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const goals = yield* SessionGoal.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Goal reviewer isolation",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "start the isolation goal" }],
    })
    yield* goals.set({ sessionID: session.id, objective: "keep the reviewer out of worker context" })
    yield* llm.push(
      reply().text("First increment.").tool("goal", { status: "complete", reason: "first increment evidence" }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom((hit) => {
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
      return `VERDICT: NOT_MET ${nonce} keep going`
    })
    yield* llm.push(
      reply().text("Second increment.").tool("goal", { status: "complete", reason: "second increment evidence" }),
    )
    yield* llm.text("Claim submitted; awaiting review.")
    yield* llm.textFrom((hit) => {
      const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
      return `VERDICT: MET ${nonce} verified`
    })

    yield* prompt.loop({ sessionID: session.id })
    const inputs = yield* llm.inputs
    // inputs[3] is the worker turn that runs after the first review was rejected.
    const worker = JSON.stringify(inputs[3])
    expect(worker).toContain("<active-goal>")
    expect(worker).not.toContain("goal-reviewer")
    expect(worker).not.toContain("goal-review")
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.tool("task_done", { summary: "done" })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

// Mid-run injection

it.instance("a user message injected mid-run is answered before the loop returns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Injection",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* llm.hold("first answer", deferredAsPromise(gate))
    yield* llm.text("injected answer")

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "first" }],
    })
    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    // Persisted straight into the session — nothing else will ever deliver it,
    // so the running loop is the only thing that can answer it.
    const injected = yield* user(chat.id, "injected question")
    yield* Deferred.succeed(gate, void 0)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(yield* llm.calls).toBe(2)
    expect(yield* llm.pending).toBe(0)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(injected.id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "injected answer")).toBe(true)

    const inputs = yield* llm.inputs
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "injected question" })
  }),
)

it.instance("a user message injected while the final response streams is answered in the same run", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Final step injection",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* llm.tool("glob", { pattern: "*" })
    // The last queued response of the turn: the injection lands while it is
    // still on the wire, after the loop already re-read the transcript.
    yield* llm.hold("turn complete", deferredAsPromise(gate))
    yield* llm.text("injected answer")

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "do the thing" }],
    })
    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(2)
    const injected = yield* user(chat.id, "one more thing")
    yield* Deferred.succeed(gate, void 0)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    // The third request only happens if the loop refuses to return with an
    // unanswered message.
    expect(yield* llm.calls).toBe(3)
    expect(yield* llm.pending).toBe(0)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const last = msgs.filter((msg) => msg.info.role === "assistant").at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected final assistant")
    expect(last.info.parentID).toBe(injected.id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "injected answer")).toBe(true)
  }),
)

it.instance("prompting a completed session resumes with the earlier transcript", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Resume",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* llm.text("first answer")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "first question" }],
    })

    yield* llm.text("second answer")
    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "second question" }],
    })

    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    const inputs = yield* llm.inputs
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain("first question")
    expect(serialized).toContain("first answer")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second question" })
  }),
)

it.instance("a mid-run injection resets the step budget", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: { build: { steps: 2 } },
    }))
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Step budget",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* llm.tool("glob", { pattern: "*" })
    // Step 2 of 2: this request carries MAX_STEPS_PROMPT.
    yield* llm.hold("wrapping up", deferredAsPromise(gate))
    yield* llm.text("injected answer")

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "do the thing" }],
    })
    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(2)
    yield* user(chat.id, "one more thing")
    yield* Deferred.succeed(gate, void 0)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(yield* llm.calls).toBe(3)

    // JSON-escaped so the comparison survives the newlines inside the prompt.
    const maxSteps = JSON.stringify(MAX_STEPS_PROMPT).slice(1, -1)
    const inputs = yield* llm.inputs
    // Step 2 of 2 is the last step and is told so...
    expect(JSON.stringify(inputs[1])).toContain(maxSteps)
    // ...but the injection restarts the budget, so the turn answering it is not.
    expect(JSON.stringify(inputs[2])).not.toContain(maxSteps)
  }),
)

it.instance(
  "a user message injected during a long goal review is answered without disturbing goal accounting",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const goals = yield* SessionGoal.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Goal injection",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "start the durable goal" }],
      })
      yield* goals.set({ sessionID: session.id, objective: "continue once, then finish" })

      // Turn 1, rejected: produces the single goal continuation.
      yield* llm.push(
        reply()
          .text("First increment complete.")
          .tool("goal", { status: "complete", reason: "first increment evidence" }),
      )
      yield* llm.text("Claim submitted; awaiting review.")
      yield* llm.textFrom((hit) => {
        const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
        return `VERDICT: NOT_MET ${nonce} another increment is still required`
      })
      // Turn 2, accepted. The accepting review is the dangerous window: the goal
      // completes, so no continuation is queued and the loop is about to break
      // with the injected message unanswered. The reviewer streams slowly so the
      // injection lands squarely inside it.
      yield* llm.push(
        reply()
          .text("Second increment complete.")
          .tool("goal", { status: "complete", reason: "second increment evidence" }),
      )
      yield* llm.text("Claim submitted; awaiting review.")
      yield* llm.textChunksFrom(
        (hit) => {
          const nonce = /verdict nonce for this review is ([a-z0-9-]+)/i.exec(JSON.stringify(hit.body))?.[1]
          return [
            "Reading the repository state\n",
            "Comparing against every explicit requirement\n",
            "Re-running the authoritative check\n",
            `VERDICT: MET ${nonce} objective verified`,
          ]
        },
        { pace: 250 },
      )
      yield* llm.text("Checked the config path too.")

      const fiber = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(6), "timed out waiting for the accepting reviewer request", "20 seconds")
      const injected = yield* user(session.id, "also double check the config path")

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      const goal = yield* goals.get(session.id)
      expect(goal?.status).toBe("complete")
      // Two worker turns. The turn that answers the injection runs after the
      // goal completed, so it is not a goal turn and cannot be double-counted.
      expect(goal?.turns).toBe(2)

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const continuations = msgs.filter(
        (msg) => msg.info.role === "user" && msg.parts.some((part) => "synthetic" in part && part.synthetic === true),
      )
      expect(continuations).toHaveLength(1)

      const answered = msgs.find((msg) => msg.info.role === "assistant" && msg.info.parentID === injected.id)
      expect(answered).toBeDefined()
      expect(answered?.parts.some((part) => part.type === "text" && part.text === "Checked the config path too.")).toBe(
        true,
      )

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(7)
      expect(JSON.stringify(inputs[6])).toContain("also double check the config path")

      const reviewParts = msgs.flatMap((msg) =>
        msg.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "goal-review"),
      )
      expect(reviewParts).toHaveLength(2)
      expect(reviewParts[1]?.state.status).toBe("completed")
    }),
  30_000,
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
