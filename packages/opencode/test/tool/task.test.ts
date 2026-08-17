import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { eq } from "drizzle-orm"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskDoneTool } from "../../src/tool/task-done"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { TaskOutputTool } from "../../src/tool/task-output"
import { TaskStopTool } from "../../src/tool/task-stop"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const taskModelConfig = {
  provider: {
    test: {
      name: "Task Test",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: Object.fromEntries(
        ["test-model", "agent-model", "call-model", "model-a", "model-b", "model-c"].map((modelID) => [
          modelID,
          {
            name: modelID,
            limit: { context: 8_000, output: 2_000 },
            variants: { high: {} },
          },
        ]),
      ),
      options: { apiKey: "test" },
    },
  },
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      Provider.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))
// Background subagents are on by default now; this exercises the kill switch.
const backgroundDisabled = testEffect(layer({ experimentalBackgroundSubagents: false }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "tool",
        callID: `call_${id}`,
        tool: TaskDoneTool.id,
        state: {
          status: "completed",
          input: { summary: text },
          output: "Completion recorded. This task is now finished.",
          title: "Completion recorded",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      },
    ],
  }
}

function textReply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const result = reply(input, text)
  return { ...result, parts: result.parts.filter((part) => part.type !== "tool") }
}

describe("tool.task", () => {
  it.instance("task_done refuses top-level sessions and empty summaries", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Top-level" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const tool = yield* TaskDoneTool
      const def = yield* tool.init()
      const context = (sessionID: SessionID) => ({
        sessionID,
        messageID: MessageID.ascending(),
        agent: "general",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      })

      const topLevel = yield* def.execute({ summary: "finished" }, context(parent.id))
      const empty = yield* def.execute({ summary: "   " }, context(child.id))

      expect(topLevel.title).toBe("No parent task")
      expect(topLevel.output).toContain("top-level session")
      expect(empty.title).toBe("Summary missing")
      expect(empty.output).toContain("Call task_done again")
    }),
  )

  it.instance("registry exposes task_done only to normal subagent children", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const registry = yield* ToolRegistry.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const ids = (agent: Agent.Info, parentID?: SessionID) =>
        registry.tools({ ...ref, agent, parentID }).pipe(Effect.map((tools) => tools.map((tool) => tool.id)))

      expect(yield* ids(build)).not.toContain(TaskDoneTool.id)
      expect(yield* ids({ ...build, goalReviewer: true }, SessionID.make("ses_parent"))).not.toContain(TaskDoneTool.id)
      expect(yield* ids({ ...build, hidden: true }, SessionID.make("ses_parent"))).not.toContain(TaskDoneTool.id)
      expect(yield* ids(build, SessionID.make("ses_parent"))).toContain(TaskDoneTool.id)
    }),
  )

  it.instance("reprompts immediately until task_done and returns its summary", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const prompts: SessionPrompt.PromptInput[] = []
      const metadata: { title?: string; metadata?: Record<string, unknown> }[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            prompts.push(input)
            if (prompts.length === 1) return textReply(input, "partial response before provider drop")
            return reply(input, "recovered completion summary")
          }),
      }

      const result = yield* def.execute(
        {
          description: "recover dropped child",
          prompt: "inspect the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: (input) =>
            Effect.sync(() => {
              metadata.push(input)
            }),
          ask: () => Effect.void,
        },
      )

      expect(prompts).toHaveLength(2)
      expect(prompts[0]?.parts).toContainEqual({
        type: "text",
        synthetic: true,
        text: "<subagent-contract>When you have fully completed this task, call task_done with a summary of the outcome as your FINAL tool call. Your work is not considered finished until you do. If you cannot finish, still call task_done and explain why in the summary.</subagent-contract>",
      })
      expect(prompts[1]?.parts).toEqual([
        {
          type: "text",
          synthetic: true,
          text: "<done-marker-missing>Your previous turn ended without a task_done call. If the task is finished, call task_done with your summary now. If it is not finished, continue working and call task_done when it is.</done-marker-missing>",
        },
      ])
      expect(result.output).toContain("recovered completion summary")
      expect(result.output).not.toContain("partial response before provider drop")
      expect(metadata).toHaveLength(3)
      expect(metadata[1]?.title).toBe("recover dropped child · recovering (no completion marker, attempt 1)")
      expect(metadata[1]?.metadata).toMatchObject({
        parentSessionId: chat.id,
        sessionId: result.metadata.sessionId,
        doneMarkerMisses: 1,
      })
      expect(typeof metadata[1]?.metadata?.nextReprompt).toBe("number")
      expect(metadata[2]).toMatchObject({
        title: "recover dropped child",
        metadata: {
          parentSessionId: chat.id,
          sessionId: result.metadata.sessionId,
          doneMarkerMisses: 1,
          recovered: true,
        },
      })
      expect(result.metadata).toMatchObject({ doneMarkerMisses: 1, recovered: true })
    }),
  )

  background.instance("clears done-marker retry status when cancelled during backoff", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const statuses = yield* SessionStatus.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const secondMiss = yield* Deferred.make<void>()
      let childPrompts = 0

      const result = yield* def.execute(
        {
          description: "cancel recovering child",
          prompt: "inspect the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) => {
                if (input.sessionID === chat.id) return Effect.succeed(reply(input, "notified"))
                childPrompts += 1
                return Effect.succeed(textReply(input, `missing marker ${childPrompts}`))
              },
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: (input) =>
            input.metadata?.doneMarkerMisses === 2 ? Deferred.succeed(secondMiss, undefined) : Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* Deferred.await(secondMiss)
      yield* Effect.sleep(10)
      expect(yield* statuses.get(result.metadata.sessionId)).toMatchObject({ type: "retry", attempt: 2 })

      yield* jobs.cancel(result.metadata.sessionId)
      expect(yield* statuses.get(result.metadata.sessionId)).toEqual({ type: "idle" })
    }),
  )

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  // task_id is a plain string the model supplies. Resuming or steering a task
  // is at least as powerful as reading or stopping one, and both of those
  // verify descendancy, so this must too — otherwise a session can drive a
  // sibling's subagent or another goal's worker.
  it.instance("execute refuses a task_id that is not a descendant", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const stranger = yield* sessions.create({ title: "Unrelated session" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false
      const promptOps = stubOps({ onPrompt: () => (prompted = true) })

      const exit = yield* def
        .execute(
          {
            description: "hijack",
            prompt: "do my bidding",
            subagent_type: "general",
            task_id: stranger.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
          model: ref,
        },
      })
    }),
  )

  it.instance(
    "rejects an unknown per-call model before creating a child session",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              model: "test/missing-model",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("Unknown model: test/missing-model")
          expect(String(Cause.squash(exit.cause))).toContain("opencode models")
        }
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    { config: taskModelConfig },
  )

  it.instance(
    "per-call model overrides the agent model and is included in result metadata",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
            model: "test/call-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual({
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("call-model"),
        })
        expect(result.metadata.modelID).toBe(ModelV2.ID.make("call-model"))
        expect(result.metadata.providerID).toBe(ProviderV2.ID.make("test"))
        expect(result.metadata.model).toEqual({
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("call-model"),
        })
      }),
    {
      config: {
        ...taskModelConfig,
        agent: { reviewer: { mode: "subagent", model: "test/agent-model" } },
      },
    },
  )

  it.instance(
    "per-call variant applies when the agent has a configured model",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
            variant: "high",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model?.modelID).toBe(ModelV2.ID.make("agent-model"))
        expect(seen?.variant).toBe("high")
      }),
    {
      config: {
        ...taskModelConfig,
        agent: { reviewer: { mode: "subagent", model: "test/agent-model" } },
      },
    },
  )

  it.instance(
    "resolved model is included in permission and result metadata",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let permission: unknown

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/call-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) => Effect.sync(() => (permission = input)),
          },
        )

        expect(permission).toEqual({
          permission: "task",
          patterns: ["general"],
          always: ["*"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
            model: {
              providerID: ProviderV2.ID.make("test"),
              modelID: ModelV2.ID.make("call-model"),
            },
          },
        })
        expect(result.metadata.modelID).toBe(ModelV2.ID.make("call-model"))
        expect(result.metadata.providerID).toBe(ProviderV2.ID.make("test"))
      }),
    { config: taskModelConfig },
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  backgroundDisabled.instance("hides and rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const registry = yield* ToolRegistry.Service
      const visible = (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)
      if (!visible) throw new Error("task tool not found")
      const schema = ToolJsonSchema.fromTool(visible) as { properties?: Record<string, unknown> }

      expect(schema.properties).not.toHaveProperty("background")

      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain(
          "Background subagents are disabled (OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false)",
        )
      }
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance(
    "runs concurrent background children of one agent on different per-call models",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const seen = new Map<SessionID, ModelV2.ID>()
        const models = ["model-a", "model-b", "model-c"]
        const context = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: stubOps({
              onPrompt: (input) => {
                if (input.sessionID !== chat.id && input.model) seen.set(input.sessionID, input.model.modelID)
              },
            }),
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }

        const results = yield* Effect.all(
          models.map((modelID) =>
            def.execute(
              {
                description: `compare ${modelID}`,
                prompt: "inspect the same problem",
                subagent_type: "general",
                model: `test/${modelID}`,
                background: true,
              },
              context,
            ),
          ),
          { concurrency: "unbounded" },
        )
        const waited = yield* Effect.all(
          results.map((result) => jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })),
          { concurrency: "unbounded" },
        )

        expect(waited.map((result) => result.info?.status)).toEqual(["completed", "completed", "completed"])
        results.forEach((result, index) => {
          expect(result.metadata.modelID).toBe(ModelV2.ID.make(models[index]))
          expect(result.metadata.providerID).toBe(ProviderV2.ID.make("test"))
          expect(seen.get(result.metadata.sessionId)).toBe(ModelV2.ID.make(models[index]))
        })
      }),
    { config: taskModelConfig },
  )

  background.instance("steering a running background task delivers the message immediately", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      // The steering message must reach the child while its first run is still
      // in flight (first has NOT resolved yet). Previously it was queued behind
      // the running turn, which made "course-correct a running agent"
      // impossible — the correction only landed after the work it meant to
      // redirect had finished.
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      first.resolve()

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      // The job settles from the run it started with. This stub calls prompt()
      // once per message, so the steering answer is a separate call whose result
      // the job never sees. Against a real loop the injected message is answered
      // inside the original run (the runLoop re-check keeps it alive), so the
      // job output does reflect the correction — see the end-to-end coverage in
      // test/tool/task-steering.test.ts, which drives real child sessions.
      expect(waited.info?.output).toBe("first done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") {
        // The notification is an envelope the model is told is not user input,
        // carrying the job's result and the ids needed to resume or inspect it.
        expect(notification.parts[0].text).toContain('<task-notification task_id="')
        expect(notification.parts[0].text).toContain('status="completed"')
        expect(notification.parts[0].text).toContain("It is not a message from the user")
        expect(notification.parts[0].text).toContain("first done")
        expect(notification.parts[0].text).toContain("task_output(task_id=")
      }
    }),
  )

  background.instance("logs a steering prompt that fails to persist", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Running child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const logged = defer<unknown>()

      yield* jobs.start({ id: child.id, type: "task", run: Effect.never })
      const result = yield* def
        .execute(
          {
            description: "add investigation scope",
            prompt: "also inspect cancellation",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: () => Effect.fail(new Error("prompt persistence failed")),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(
          Effect.provide(
            Logger.layer([
              Logger.make((entry) => {
                if (JSON.stringify(entry.message).includes("failed to steer background task"))
                  logged.resolve(entry.message)
              }),
            ]),
          ),
        )

      expect(result.output).toContain("Background task updated")
      const entry = yield* Effect.promise(() => logged.promise).pipe(Effect.timeout("1 second"))
      expect(JSON.stringify(entry)).toContain("failed to steer background task")
      expect(JSON.stringify(entry)).toContain(chat.id)
      expect(JSON.stringify(entry)).toContain(child.id)
    }),
  )

  background.instance("reports when steering races with an already settled task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Settling child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      yield* jobs.start({ id: child.id, type: "task", run: Effect.never })
      const result = yield* def.execute(
        {
          description: "add late context",
          prompt: "inspect the final state too",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) => jobs.cancel(child.id).pipe(Effect.as(reply(input, "new run done"))),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("Background task restarted")
      expect(result.output).toContain("finished before the additional context")
      expect(result.output).toContain("did not arm another automatic completion notification")
      expect(result.output).not.toContain("Background task updated")
    }),
  )

  background.instance("uses one notification nonce for all envelopes in an instance", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const delivered = defer<SessionPrompt.PromptInput[]>()
      const notifications: SessionPrompt.PromptInput[] = []
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.sync(() => {
            if (input.sessionID === chat.id) {
              notifications.push(input)
              if (notifications.length === 2) delivered.resolve(notifications)
            }
            return reply(input, "background done")
          }),
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      yield* def.execute(
        {
          description: "inspect first bug",
          prompt: "inspect the first path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      yield* def.execute(
        {
          description: "inspect second bug",
          prompt: "inspect the second path",
          subagent_type: "general",
          background: true,
        },
        context,
      )

      const envelopes = (yield* Effect.promise(() => delivered.promise)).map((input) => {
        const part = input.parts[0]
        expect(part?.type).toBe("text")
        return part?.type === "text" ? part.text : ""
      })
      const nonces = envelopes.map((envelope) => /<task-notification [^>]*nonce="([^"]+)"/.exec(envelope)?.[1])
      expect(nonces[0]).toBeDefined()
      expect(nonces[1]).toBe(nonces[0])
      // The nonce must NEVER reach the model. This description is rendered into
      // every agent that can see the task tool, subagents included, so
      // publishing it would hand the secret to the only party able to abuse
      // it: an injected subagent could read it from its own context and forge
      // a perfect notification at its parent.
      expect(def.description).not.toContain(nonces[0]!)
      expect(def.description).toContain("always arrives as a separate message of its own")
    }),
  )

  it.instance("task_output refuses a task whose ancestor was deleted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const ancestor = yield* sessions.create({ parentID: chat.id, title: "Deleted ancestor" })
      const task = yield* sessions.create({ parentID: ancestor.id, title: "Orphaned task" })
      const tool = yield* TaskOutputTool
      const def = yield* tool.init()

      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, ancestor.id)).run().pipe(Effect.orDie)
      const exit = yield* def
        .execute(
          { task_id: task.id },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {},
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain(`Task ${task.id} is not owned by session ${chat.id}`)
      }
    }),
  )

  it.instance("task_stop refuses a task whose ancestor was deleted", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const ancestor = yield* sessions.create({ parentID: chat.id, title: "Deleted ancestor" })
      const task = yield* sessions.create({ parentID: ancestor.id, title: "Orphaned task" })
      const tool = yield* TaskStopTool
      const def = yield* tool.init()

      yield* database.db.delete(SessionTable).where(eq(SessionTable.id, ancestor.id)).run().pipe(Effect.orDie)
      const exit = yield* def
        .execute(
          { task_id: task.id },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain(`Task ${task.id} is not owned by session ${chat.id}`)
      }
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background completion notification reports done-marker recovery", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let childPrompts = 0

      const result = yield* def.execute(
        {
          description: "recover background child",
          prompt: "inspect the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) => {
                if (input.sessionID === chat.id) {
                  return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "notification handled")))
                }
                childPrompts += 1
                if (childPrompts === 1) return Effect.succeed(textReply(input, "provider dropped"))
                return Effect.succeed(reply(input, "background recovered"))
              },
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      const notification = yield* Deferred.await(injected)
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") {
        expect(notification.parts[0].text).toContain(
          "<summary>Background task completed: recover background child (recovered after 1 reprompts)</summary>",
        )
      }
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run leaves running background tasks alive until stopped directly", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // The parent abort must not cascade into a background child.
      yield* runState.cancel(chat.id)
      const survived = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 100 })
      expect(survived.timedOut).toBe(true)
      expect(survived.info?.status).toBe("running")

      // Targeting the child's own session (what task_stop does) still stops it.
      yield* runState.cancel(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})
