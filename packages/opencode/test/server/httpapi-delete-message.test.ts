import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Exit, Fiber, Layer } from "effect"

import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Session.node, Database.node, SessionRunState.node, SessionStatus.node])),
    httpApiLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const createUser = Effect.fn("Test.createUser")(function* (sessionID: SessionID, synthetic = false) {
  const session = yield* Session.Service
  const message = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: message.id,
    sessionID,
    type: "text",
    text: "queued user input",
    ...(synthetic ? { synthetic: true } : {}),
  })
  return message
})

const createAssistant = Effect.fn("Test.createAssistant")(function* (sessionID: SessionID, parentID: MessageID) {
  const session = yield* Session.Service
  const message: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: Date.now(), completed: Date.now() },
  }
  return yield* session.updateMessage(message)
})

const startBusy = Effect.fn("Test.startBusy")(function* (sessionID: SessionID) {
  const runState = yield* SessionRunState.Service
  const fiber = yield* runState.ensureRunning(sessionID, Effect.interrupt, Effect.never).pipe(Effect.forkChild)
  yield* pollWithTimeout(
    runState.assertNotBusy(sessionID).pipe(
      Effect.exit,
      Effect.map((exit) => (Exit.isFailure(exit) ? true : undefined)),
    ),
    `session ${sessionID} never became busy`,
  )
  return fiber
})

function pathFor(sessionID: SessionID, messageID: MessageID) {
  return SessionPaths.deleteMessage.replace(":sessionID", sessionID).replace(":messageID", messageID)
}

describe("deleteMessage while busy", () => {
  it.instance("deletes a message while the session is idle", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* Session.Service
      const info = yield* session.create({})
      const message = yield* createUser(info.id)

      const response = yield* requestInDirectory(pathFor(info.id, message.id), test.directory, { method: "DELETE" })

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
      expect((yield* session.messages({ sessionID: info.id })).map((item) => item.info.id)).not.toContain(message.id)
    }),
  )

  it.instance("deletes a queued user message while the session is busy", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* Session.Service
      const runState = yield* SessionRunState.Service
      const info = yield* session.create({})
      const answered = yield* createUser(info.id)
      yield* createAssistant(info.id, answered.id)
      const queued = yield* createUser(info.id)
      const fiber = yield* startBusy(info.id)

      const response = yield* requestInDirectory(pathFor(info.id, queued.id), test.directory, { method: "DELETE" })
      yield* runState.cancel(info.id)
      yield* Fiber.await(fiber)

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
      expect((yield* session.messages({ sessionID: info.id })).map((item) => item.info.id)).not.toContain(queued.id)
    }),
  )

  it.instance("rejects deleting an answered user message while the session is busy", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* Session.Service
      const runState = yield* SessionRunState.Service
      const info = yield* session.create({})
      const answered = yield* createUser(info.id)
      yield* createAssistant(info.id, answered.id)
      const fiber = yield* startBusy(info.id)

      const response = yield* requestInDirectory(pathFor(info.id, answered.id), test.directory, { method: "DELETE" })
      const body = yield* response.json
      yield* runState.cancel(info.id)
      yield* Fiber.await(fiber)

      expect(response.status).toBe(409)
      expect(body).toMatchObject({
        _tag: "SessionBusyError",
        sessionID: info.id,
      })
      expect((yield* session.messages({ sessionID: info.id })).map((item) => item.info.id)).toContain(answered.id)
    }),
  )

  it.instance("rejects deleting a queued synthetic-only user message while the session is busy", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* Session.Service
      const runState = yield* SessionRunState.Service
      const info = yield* session.create({})
      const answered = yield* createUser(info.id)
      yield* createAssistant(info.id, answered.id)
      const queued = yield* createUser(info.id, true)
      const fiber = yield* startBusy(info.id)

      const response = yield* requestInDirectory(pathFor(info.id, queued.id), test.directory, { method: "DELETE" })
      const body = yield* response.json
      yield* runState.cancel(info.id)
      yield* Fiber.await(fiber)

      expect(response.status).toBe(409)
      expect(body).toMatchObject({
        _tag: "SessionBusyError",
        sessionID: info.id,
      })
      expect((yield* session.messages({ sessionID: info.id })).map((item) => item.info.id)).toContain(queued.id)
    }),
  )
})
