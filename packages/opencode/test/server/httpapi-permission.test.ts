import { afterEach, describe, expect } from "bun:test"
import { Server } from "../../src/server/server"
import { Effect } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

function app() {
  return Server.Default().app
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const call = (directory: string, path: string, init?: RequestInit) =>
  Effect.promise(() =>
    Promise.resolve(
      app().request(path, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": directory,
          ...(init?.headers ?? {}),
        },
      }),
    ),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("permission HttpApi", () => {
  it.live(
    "toggles auto mode for a session and reports the status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })
      const created = yield* call(tmp.path, "/session", { method: "POST", body: JSON.stringify({ title: "auto" }) })
      expect(created.status).toBe(200)
      const sessionID = ((yield* Effect.promise(() => created.json())) as { id: string }).id

      const off = yield* call(tmp.path, `/permission/auto/${sessionID}`)
      expect(off.status).toBe(200)
      expect(yield* Effect.promise(() => off.json())).toMatchObject({ enabled: false, explicit: false })

      const set = yield* call(tmp.path, "/permission/auto", {
        method: "POST",
        body: JSON.stringify({ sessionID, enabled: true }),
      })
      expect(set.status).toBe(200)
      expect(yield* Effect.promise(() => set.json())).toMatchObject({ enabled: true, explicit: true })

      const on = yield* call(tmp.path, `/permission/auto/${sessionID}`)
      expect(yield* Effect.promise(() => on.json())).toMatchObject({ enabled: true, explicit: true })

      const cleared = yield* call(tmp.path, "/permission/auto", {
        method: "POST",
        body: JSON.stringify({ sessionID, enabled: false }),
      })
      expect(yield* Effect.promise(() => cleared.json())).toMatchObject({ enabled: false })
    }),
  )

  it.live(
    "refuses to arm auto mode for a session that does not exist",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })

      // The endpoint is unauthenticated and the state it writes is durable and
      // tree-wide, so at the very least it must not accept ids that name
      // nothing - those can never be listed, shown or turned back off.
      const set = yield* call(tmp.path, "/permission/auto", {
        method: "POST",
        body: JSON.stringify({ sessionID: "ses_never_created", enabled: true }),
      })
      expect(set.status).toBe(404)

      const status = yield* call(tmp.path, "/permission/auto/ses_never_created")
      expect(yield* Effect.promise(() => status.json())).toMatchObject({ enabled: false })
    }),
  )

  it.live(
    "lists grants and the auto-approval audit trail",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })

      const grants = yield* call(tmp.path, "/permission/grant")
      expect(grants.status).toBe(200)
      expect(yield* Effect.promise(() => grants.json())).toEqual([])

      const log = yield* call(tmp.path, "/permission/auto-log")
      expect(log.status).toBe(200)
      expect(yield* Effect.promise(() => log.json())).toEqual([])

      const revoked = yield* call(tmp.path, "/permission/grant/revoke", {
        method: "POST",
        body: JSON.stringify({ permission: "bash" }),
      })
      expect(revoked.status).toBe(200)
      expect(yield* Effect.promise(() => revoked.json())).toBe(0)
    }),
  )
})
