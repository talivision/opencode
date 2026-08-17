import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, type Hit, TestLLMServer } from "../lib/llm-server"

const summary = Layer.mock(SessionSummary.Service, {
  summarize: () => Effect.void,
  diff: () => Effect.succeed([]),
  computeDiff: () => Effect.succeed([]),
})

const lsp = Layer.mock(LSP.Service, {
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
})

const mcp = Layer.mock(MCP.Service, {
  status: () => Effect.succeed({}),
  clients: () => Effect.succeed({}),
  instructions: () => Effect.succeed([]),
  tools: () => Effect.succeed({}),
  prompts: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  resourceTemplates: () => Effect.succeed({}),
  connect: () => Effect.void,
  disconnect: () => Effect.void,
  supportsOAuth: () => Effect.succeed(false),
  hasStoredTokens: () => Effect.succeed(false),
  getAuthStatus: () => Effect.succeed("not_authenticated" as const),
})

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  Database.node,
  CrossSpawnSpawner.node,
  Ripgrep.node,
  BackgroundJob.node,
  SessionStatus.node,
  testLLMServerNode,
])
const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const providerCfg = (url: string): Partial<ConfigV1.Info> => ({
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
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const useServerConfig = Effect.fn("TaskSteeringTest.useServerConfig")(function* () {
  const test = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* Effect.promise(() =>
    Bun.write(path.join(test.directory, "opencode.json"), JSON.stringify(providerCfg(llm.url))),
  )
  return llm
})

const createParent = Effect.fn("TaskSteeringTest.createParent")(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({
    title: "Task steering parent",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
})

function lastUserIncludes(hit: Hit, text: string) {
  const messages = hit.body.messages
  if (!Array.isArray(messages)) return false
  return JSON.stringify(
    messages.findLast((message) => message && typeof message === "object" && message.role === "user"),
  ).includes(text)
}

const promptParent = Effect.fn("TaskSteeringTest.promptParent")(function* (
  sessionID: Session.Info["id"],
  text: string,
) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.prompt({
    sessionID,
    agent: "build",
    parts: [{ type: "text", text }],
  })
})

const spawnHangingTask = Effect.fn("TaskSteeringTest.spawnHangingTask")(function* (
  sessionID: Session.Info["id"],
  marker: string,
) {
  const llm = yield* TestLLMServer
  const sessions = yield* Session.Service
  yield* llm.toolMatch((hit) => lastUserIncludes(hit, marker), "task", {
    description: "inspect steering",
    prompt: `child work ${marker}`,
    subagent_type: "general",
    background: true,
  })
  yield* llm.pushMatch((hit) => lastUserIncludes(hit, `child work ${marker}`), reply().hang())
  yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Background task started"), "parent continues")
  yield* promptParent(sessionID, marker)
  return yield* pollWithTimeout(
    Effect.gen(function* () {
      const messages = yield* sessions.messages({ sessionID })
      const task = messages
        .flatMap((message) => message.parts)
        .find(
          (part): part is SessionV1.ToolPart =>
            part.type === "tool" && part.tool === "task" && part.state.status === "completed",
        )
      const taskID = task?.state.status === "completed" ? task.state.metadata?.sessionId : undefined
      if (typeof taskID === "string") return SessionID.make(taskID)
    }),
    "background task did not return a task_id",
  )
})

const toolOutput = Effect.fn("TaskSteeringTest.toolOutput")(function* (sessionID: Session.Info["id"], tool: string) {
  const sessions = yield* Session.Service
  return yield* pollWithTimeout(
    Effect.gen(function* () {
      const part = (yield* sessions.messages({ sessionID }))
        .flatMap((message) => message.parts)
        .findLast((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === tool)
      if (part?.state.status === "completed") return part.state.output
    }),
    `${tool} did not complete`,
  )
})

it.instance("background task returns immediately with a task_id while its child hangs", () =>
  Effect.gen(function* () {
    yield* useServerConfig()
    const jobs = yield* BackgroundJob.Service
    const parent = yield* createParent()
    const taskID = yield* spawnHangingTask(parent.id, "spawn hanging child")

    expect(taskID).toStartWith("ses")
    expect((yield* jobs.get(taskID))?.status).toBe("running")
  }),
)

it.instance("task(task_id, prompt) persists steering while the child is busy", () =>
  Effect.gen(function* () {
    const llm = yield* useServerConfig()
    const sessions = yield* Session.Service
    const parent = yield* createParent()
    const taskID = yield* spawnHangingTask(parent.id, "spawn steerable child")

    yield* llm.toolMatch((hit) => lastUserIncludes(hit, "send steering now"), "task", {
      description: "add steering context",
      prompt: "inspect cancellation too",
      subagent_type: "general",
      task_id: taskID,
    })
    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Background task updated"), "steering sent")
    yield* promptParent(parent.id, "send steering now")

    expect(yield* toolOutput(parent.id, "task")).toContain("Background task updated")
    const persisted = yield* pollWithTimeout(
      Effect.gen(function* () {
        const message = (yield* sessions.messages({ sessionID: taskID })).find(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.text === "inspect cancellation too"),
        )
        return message ?? undefined
      }),
      "steering prompt was not persisted into the busy child",
    )
    expect(persisted.info.role).toBe("user")
  }),
)

it.instance("task_output snapshots running and completed task transcripts", () =>
  Effect.gen(function* () {
    const llm = yield* useServerConfig()
    const jobs = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const gate = yield* Deferred.make<void>()
    const parent = yield* createParent()
    const marker = "spawn observable child"

    yield* llm.toolMatch((hit) => lastUserIncludes(hit, marker), "task", {
      description: "inspect output",
      prompt: `child work ${marker}`,
      subagent_type: "general",
      background: true,
    })
    yield* llm.pushMatch(
      (hit) => lastUserIncludes(hit, `child work ${marker}`),
      reply().wait(deferredAsPromise(gate)).text("final child text").tool("task_done", { summary: "final child text" }),
    )
    yield* llm.textMatch(
      (hit) => JSON.stringify(hit.body).includes("Completion recorded. This task is now finished."),
      "final child text",
    )
    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Background task started"), "parent continues")
    yield* promptParent(parent.id, marker)
    const taskID = yield* pollWithTimeout(
      Effect.gen(function* () {
        const job = (yield* jobs.list()).find((job) => job.metadata?.parentSessionId === parent.id)
        return job?.status === "running" ? SessionID.make(job.id) : undefined
      }),
      "observable task did not start",
    )

    yield* llm.toolMatch((hit) => lastUserIncludes(hit, "read running output"), "task_output", {
      task_id: taskID,
    })
    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("<background_status>running"), "still running")
    yield* promptParent(parent.id, "read running output")
    expect(yield* toolOutput(parent.id, "task_output")).toContain('status="running"')

    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("task-notification"), "notification received")
    yield* Deferred.succeed(gate, undefined)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const job = yield* jobs.get(taskID)
        return job?.status === "completed" ? job : undefined
      }),
      "observable task did not complete",
    )
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const notification = (yield* sessions.messages({ sessionID: parent.id })).find((message) =>
          message.parts.some((part) => part.type === "text" && part.metadata?.taskSessionID === taskID),
        )
        return notification ?? undefined
      }),
      "completion notification was not persisted",
    )

    yield* llm.toolMatch((hit) => lastUserIncludes(hit, "read completed output"), "task_output", {
      task_id: taskID,
    })
    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("final child text"), "output read")
    yield* promptParent(parent.id, "read completed output")
    const output = yield* toolOutput(parent.id, "task_output")
    expect(output).toContain("<background_status>completed</background_status>")
    expect(output).toContain("final child text")
  }),
)

it.instance("task_stop cancels the child and injects a stopped notification", () =>
  Effect.gen(function* () {
    const llm = yield* useServerConfig()
    const jobs = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const parent = yield* createParent()
    const taskID = yield* spawnHangingTask(parent.id, "spawn stoppable child")

    yield* llm.toolMatch((hit) => lastUserIncludes(hit, "stop the child"), "task_stop", {
      task_id: taskID,
    })
    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes('status=\\"stopped\\"'), "child stopped")
    yield* promptParent(parent.id, "stop the child")

    expect((yield* jobs.get(taskID))?.status).toBe("cancelled")
    expect((yield* status.get(taskID)).type).toBe("idle")
    const notification = yield* pollWithTimeout(
      Effect.gen(function* () {
        const part = (yield* sessions.messages({ sessionID: parent.id }))
          .flatMap((message) => (message.info.role === "user" ? message.parts : []))
          .find(
            (part): part is SessionV1.TextPart =>
              part.type === "text" &&
              part.metadata?.taskNotification === true &&
              part.metadata.taskSessionID === taskID,
          )
        return part ?? undefined
      }),
      "stopped notification was not persisted",
    )
    expect(notification.text).toContain('status="stopped"')
  }),
)

it.instance("task_stop refuses a session that is not a descendant", () =>
  Effect.gen(function* () {
    const llm = yield* useServerConfig()
    const sessions = yield* Session.Service
    const parent = yield* createParent()
    const unrelated = yield* sessions.create({ title: "Unrelated session" })

    yield* llm.toolMatch((hit) => lastUserIncludes(hit, "stop unrelated"), "task_stop", {
      task_id: unrelated.id,
    })
    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("not owned by session"), "refused")
    yield* promptParent(parent.id, "stop unrelated")

    const refusal = yield* pollWithTimeout(
      Effect.gen(function* () {
        const part = (yield* sessions.messages({ sessionID: parent.id }))
          .flatMap((message) => message.parts)
          .findLast(
            (part): part is SessionV1.ToolPart =>
              part.type === "tool" && part.tool === "task_stop" && part.state.status === "error",
          )
        return part?.state.status === "error" ? part.state.error : undefined
      }),
      "task_stop did not refuse the unrelated session",
    )
    expect(refusal).toContain(`Task ${unrelated.id} is not owned by session ${parent.id}`)
  }),
)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => onrejected?.(error),
          onSuccess: (value) => onfulfilled?.(value),
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})
