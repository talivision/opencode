import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([SessionNs.node, BackgroundJob.node])), httpApiLayer),
)

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] } }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.metadata).toEqual(next.metadata)

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "abort route returns success",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "goal reviewer sessions reject prompts",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(
          SessionNs.use.create({ metadata: { goalReviewer: true } }),
          (created) => SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const headers = { "Content-Type": "application/json" }
        const message = "Goal reviewer sessions are read-only; their independence is what makes the review meaningful."
        const requests = [
          {
            path: `/session/${session.id}/message`,
            body: { noReply: true, parts: [{ type: "text", text: "follow-up" }] },
          },
          {
            path: `/session/${session.id}/prompt_async`,
            body: { noReply: true, parts: [{ type: "text", text: "follow-up" }] },
          },
          {
            path: `/session/${session.id}/command`,
            body: { command: "review", arguments: "" },
          },
        ]

        yield* Effect.forEach(requests, (input) =>
          Effect.gen(function* () {
            const response = yield* requestInDirectory(input.path, test.directory, {
              method: "POST",
              headers,
              body: JSON.stringify(input.body),
            })

            expect(response.status).toBe(400)
            expect(yield* response.json).toEqual({ _tag: "InvalidRequestError", message })
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "lists live background jobs by parent session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const parent = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const child = yield* Effect.acquireRelease(SessionNs.use.create({ parentID: parent.id }), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const jobs = yield* BackgroundJob.Service

        const initial = yield* requestInDirectory("/experimental/background-job", test.directory)
        expect(initial.status).toBe(200)
        expect(yield* initial.json).toEqual([])

        const job = yield* Effect.acquireRelease(
          jobs.start({
            id: child.id,
            type: "task",
            title: "background review",
            metadata: {
              sessionId: child.id,
              parentSessionId: parent.id,
            },
            run: Effect.never,
          }),
          (created) => jobs.cancel(created.id).pipe(Effect.ignore),
        )
        const expected = [
          {
            id: job.id,
            sessionID: child.id,
            parentSessionID: parent.id,
            status: "running",
            title: "background review",
          },
        ]

        const listed = yield* requestInDirectory("/experimental/background-job", test.directory)
        expect(listed.status).toBe(200)
        expect(yield* listed.json).toEqual(expected)

        const filtered = yield* requestInDirectory(
          `/experimental/background-job?parentSessionId=${parent.id}`,
          test.directory,
        )
        expect(filtered.status).toBe(200)
        expect(yield* filtered.json).toEqual(expected)

        const excluded = yield* requestInDirectory(
          `/experimental/background-job?parentSessionId=${child.id}`,
          test.directory,
        )
        expect(excluded.status).toBe(200)
        expect(yield* excluded.json).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )
})
