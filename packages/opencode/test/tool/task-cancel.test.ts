import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
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
  SessionRunState.node,
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

const useServerConfig = Effect.fn("TaskCancelTest.useServerConfig")(function* () {
  const test = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* Effect.promise(() =>
    Bun.write(path.join(test.directory, "opencode.json"), JSON.stringify(providerCfg(llm.url))),
  )
  return llm
})

const createParent = Effect.fn("TaskCancelTest.createParent")(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({
    title: "Task cancel parent",
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

const promptParent = Effect.fn("TaskCancelTest.promptParent")(function* (sessionID: Session.Info["id"], text: string) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.prompt({
    sessionID,
    agent: "build",
    parts: [{ type: "text", text }],
  })
})

/** Runs one parent turn that spawns a background subagent whose provider call hangs. */
const spawnHangingBackgroundTask = Effect.fn("TaskCancelTest.spawnHangingBackgroundTask")(function* (
  sessionID: Session.Info["id"],
  marker: string,
) {
  const llm = yield* TestLLMServer
  const jobs = yield* BackgroundJob.Service
  const status = yield* SessionStatus.Service
  yield* llm.toolMatch((hit) => lastUserIncludes(hit, marker), "task", {
    description: "hanging child",
    prompt: `child work ${marker}`,
    subagent_type: "general",
    background: true,
  })
  yield* llm.pushMatch((hit) => lastUserIncludes(hit, `child work ${marker}`), reply().hang())
  yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Background task started"), "parent continues")
  yield* promptParent(sessionID, marker)
  const taskID = yield* pollWithTimeout(
    Effect.gen(function* () {
      const job = (yield* jobs.list()).find(
        (job) => job.metadata?.parentSessionId === sessionID && job.metadata?.background === true,
      )
      return job?.status === "running" ? SessionID.make(job.id) : undefined
    }),
    "background task did not start",
  )
  yield* pollWithTimeout(
    Effect.map(status.get(taskID), (info) => (info.type === "busy" ? info : undefined)),
    "background child never went busy",
  )
  return taskID
})

const awaitStatus = Effect.fn("TaskCancelTest.awaitStatus")(function* (
  sessionID: SessionID,
  type: SessionStatus.Info["type"],
) {
  const status = yield* SessionStatus.Service
  return yield* pollWithTimeout(
    Effect.map(status.get(sessionID), (info) => (info.type === type ? info : undefined)),
    `session ${sessionID} never became ${type}`,
  )
})

const awaitJobStatus = Effect.fn("TaskCancelTest.awaitJobStatus")(function* (
  jobID: string,
  status: BackgroundJob.Status,
) {
  const jobs = yield* BackgroundJob.Service
  return yield* pollWithTimeout(
    Effect.map(jobs.get(jobID), (job) => (job?.status === status ? job : undefined)),
    `job ${jobID} never became ${status}`,
  )
})

it.instance(
  "aborting the parent leaves a hanging background child running, and stopping the child notifies the parent",
  () =>
    Effect.gen(function* () {
      const llm = yield* useServerConfig()
      const jobs = yield* BackgroundJob.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const parent = yield* createParent()
      const taskID = yield* spawnHangingBackgroundTask(parent.id, "spawn surviving child")

      // Parent starts a fresh turn that hangs, then the user aborts it.
      yield* llm.pushMatch((hit) => lastUserIncludes(hit, "parent hangs now"), reply().hang())
      const turn = yield* promptParent(parent.id, "parent hangs now").pipe(Effect.ignore, Effect.forkChild)
      yield* awaitStatus(parent.id, "busy")
      yield* prompt.cancel(parent.id)
      yield* awaitWithTimeout(Fiber.await(turn), "aborted parent turn did not settle", "10 seconds")

      // The abort must not cascade into the background child.
      expect((yield* status.get(parent.id)).type).toBe("idle")
      expect((yield* jobs.get(taskID))?.status).toBe("running")
      expect((yield* status.get(taskID)).type).toBe("busy")

      // Cancelling the child directly (what task_stop does) settles both sides.
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("task-notification"), "notification handled")
      yield* prompt.cancel(taskID)
      expect((yield* awaitJobStatus(taskID, "cancelled")).status).toBe("cancelled")
      yield* awaitStatus(taskID, "idle")

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
        "stopped notification was not delivered to the parent",
      )
      expect(notification.text).toContain('status="stopped"')
      expect(notification.text).toContain(`task_id="${taskID}"`)
    }),
  20_000,
)

it.instance(
  "aborting the parent still cascades into a foreground task child",
  () =>
    Effect.gen(function* () {
      const llm = yield* useServerConfig()
      const jobs = yield* BackgroundJob.Service
      const prompt = yield* SessionPrompt.Service
      const parent = yield* createParent()
      const marker = "spawn foreground child"

      yield* llm.toolMatch((hit) => lastUserIncludes(hit, marker), "task", {
        description: "foreground child",
        prompt: `child work ${marker}`,
        subagent_type: "general",
      })
      yield* llm.pushMatch((hit) => lastUserIncludes(hit, `child work ${marker}`), reply().hang())
      const turn = yield* promptParent(parent.id, marker).pipe(Effect.ignore, Effect.forkChild)

      const taskID = yield* pollWithTimeout(
        Effect.gen(function* () {
          const job = (yield* jobs.list()).find((job) => job.metadata?.parentSessionId === parent.id)
          return job?.status === "running" ? SessionID.make(job.id) : undefined
        }),
        "foreground task did not start",
      )
      expect((yield* jobs.get(taskID))?.metadata?.background).toBeUndefined()
      yield* awaitStatus(taskID, "busy")

      yield* prompt.cancel(parent.id)
      yield* awaitWithTimeout(Fiber.await(turn), "aborted parent turn did not settle", "10 seconds")

      expect((yield* awaitJobStatus(taskID, "cancelled")).status).toBe("cancelled")
      yield* awaitStatus(taskID, "idle")
      yield* awaitStatus(parent.id, "idle")
    }),
  20_000,
)

it.instance("cancel skips background descendants but still cancels a directly targeted background job", () =>
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service
    const parentID = SessionID.make("ses_cancel_matcher_parent")
    const backgroundID = "ses_cancel_matcher_background"
    const foregroundID = "ses_cancel_matcher_foreground"
    const grandchildID = "ses_cancel_matcher_grandchild"

    yield* jobs.start({
      id: backgroundID,
      type: "task",
      metadata: { parentSessionId: parentID, sessionId: backgroundID, background: true },
      run: Effect.never,
    })
    yield* jobs.start({
      id: foregroundID,
      type: "task",
      metadata: { parentSessionId: parentID, sessionId: foregroundID },
      run: Effect.never,
    })
    yield* jobs.start({
      id: grandchildID,
      type: "task",
      metadata: { parentSessionId: foregroundID, sessionId: grandchildID },
      run: Effect.never,
    })

    yield* runState.cancel(parentID)
    expect((yield* jobs.get(backgroundID))?.status).toBe("running")
    expect((yield* jobs.get(foregroundID))?.status).toBe("cancelled")
    expect((yield* jobs.get(grandchildID))?.status).toBe("cancelled")

    yield* runState.cancel(SessionID.make(backgroundID))
    expect((yield* jobs.get(backgroundID))?.status).toBe("cancelled")
  }),
)
