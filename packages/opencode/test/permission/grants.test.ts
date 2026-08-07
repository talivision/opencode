import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
    Session.node,
    SessionProjector.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Permission.Service.use((permission) => permission.ask(input))

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Permission.Service.use((permission) => permission.reply(input))

const grants = () => Permission.Service.use((permission) => permission.grants())

const setAuto = (sessionID: SessionID, enabled: boolean) =>
  Permission.Service.use((permission) => permission.setAuto({ sessionID, enabled }))

const getAuto = (sessionID: SessionID) => Permission.Service.use((permission) => permission.getAuto(sessionID))

const autoLog = () => Permission.Service.use((permission) => permission.autoLog())

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

/** Resolves to "pending" instead of blocking forever when a request is not auto-resolved. */
const askOrPending = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  ask(input).pipe(
    Effect.as("resolved" as const),
    Effect.timeoutOrElse({ duration: "300 millis", orElse: () => Effect.succeed("pending" as const) }),
  )

// ---------------------------------------------------------------------------
// precedence: a grant may only upgrade ask -> allow
// ---------------------------------------------------------------------------

test("evaluateGranted - grant upgrades ask to allow", () => {
  expect(
    Permission.evaluateGranted(
      "bash",
      "ls",
      [{ permission: "bash", pattern: "*", action: "ask" }],
      [{ permission: "bash", pattern: "ls", action: "allow" }],
    ).action,
  ).toBe("allow")
})

test("evaluateGranted - grant upgrades the implicit default ask", () => {
  expect(
    Permission.evaluateGranted("bash", "ls", [], [{ permission: "bash", pattern: "*", action: "allow" }]).action,
  ).toBe("allow")
})

test("evaluateGranted - explicit deny outranks a wildcard grant", () => {
  expect(
    Permission.evaluateGranted(
      "task",
      "dangerous",
      [{ permission: "task", pattern: "*", action: "deny" }],
      [{ permission: "task", pattern: "*", action: "allow" }],
    ).action,
  ).toBe("deny")
})

test("evaluateGranted - deny wins regardless of rule order", () => {
  const ruleset: PermissionV1.Ruleset = [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "rm *", action: "deny" },
  ]
  const grants: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
  expect(Permission.evaluateGranted("bash", "rm -rf /", ruleset, grants).action).toBe("deny")
  expect(Permission.evaluateGranted("bash", "ls", ruleset, grants).action).toBe("allow")
})

test("evaluateGranted - no grant leaves ask alone", () => {
  expect(
    Permission.evaluateGranted("bash", "ls", [{ permission: "bash", pattern: "*", action: "ask" }], []).action,
  ).toBe("ask")
})

it.instance(
  "grant upgrades ask to allow",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_upgrade"),
        sessionID: SessionID.make("session_upgrade"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_upgrade"), reply: "always" })
      yield* Fiber.join(fiber)

      expect(
        yield* askOrPending({
          sessionID: SessionID.make("session_upgrade_2"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("resolved")
    }),
  { git: true },
)

it.instance(
  "config deny survives an approved wildcard grant",
  () =>
    Effect.gen(function* () {
      // The task tool authors `always: ["*"]`, so one click grants a wildcard.
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_deny_grant"),
        sessionID: SessionID.make("session_grant"),
        permission: "task",
        patterns: ["goal-reviewer"],
        metadata: {},
        always: ["*"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_deny_grant"), reply: "always" })
      yield* Fiber.join(fiber)

      const exit = yield* ask({
        sessionID: SessionID.make("session_denied"),
        permission: "task",
        patterns: ["dangerous"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "task", pattern: "dangerous", action: "deny" }],
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "grant drains other pending asks in the same session",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_drain_a"),
        sessionID: SessionID.make("session_drain"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      const b = yield* ask({
        id: PermissionV1.ID.make("per_drain_b"),
        sessionID: SessionID.make("session_drain"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_drain_a"), reply: "always" })
      yield* Fiber.join(a)
      yield* Fiber.join(b)
      expect(yield* Permission.Service.use((p) => p.list())).toHaveLength(0)
    }),
  { git: true },
)

// ---------------------------------------------------------------------------
// child sessions
// ---------------------------------------------------------------------------

it.instance(
  "child session inherits a parent grant even with its own frozen ruleset",
  () =>
    Effect.gen(function* () {
      const parent = yield* ask({
        id: PermissionV1.ID.make("per_child_parent"),
        sessionID: SessionID.make("session_parent"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_child_parent"), reply: "always" })
      yield* Fiber.join(parent)

      // Child subagent session: different session, its own ruleset.
      expect(
        yield* askOrPending({
          sessionID: SessionID.make("session_child"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("resolved")
    }),
  { git: true },
)

it.instance(
  "approving in a parent releases the subagent request already waiting on it",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "goal reviewer" })

      const childAsk = yield* ask({
        id: PermissionV1.ID.make("per_lineage_child"),
        sessionID: child.id,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      const parentAsk = yield* ask({
        id: PermissionV1.ID.make("per_lineage_parent"),
        sessionID: parent.id,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_lineage_parent"), reply: "always" })
      yield* Fiber.join(parentAsk)
      yield* Fiber.join(childAsk)
      expect(yield* Permission.Service.use((p) => p.list())).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "approving does not release an unrelated session",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_unrelated_a"),
        sessionID: SessionID.make("session_unrelated_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      const b = yield* ask({
        id: PermissionV1.ID.make("per_unrelated_b"),
        sessionID: SessionID.make("session_unrelated_b"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_unrelated_a"), reply: "always" })
      yield* Fiber.join(a)
      expect((yield* Permission.Service.use((p) => p.list())).map((item) => item.id)).toEqual([
        PermissionV1.ID.make("per_unrelated_b"),
      ])
      yield* reply({ requestID: PermissionV1.ID.make("per_unrelated_b"), reply: "reject" })
      yield* Fiber.await(b)
    }),
  { git: true },
)

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

it.instance(
  "persisted grants reload in a fresh instance",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_persist"),
        sessionID: SessionID.make("session_persist"),
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: ["git *"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_persist"), reply: "always" })
      yield* Fiber.join(fiber)

      yield* store.reload({ directory: test.directory })

      expect(
        yield* askOrPending({
          sessionID: SessionID.make("session_after_restart"),
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("resolved")
    }),
  { git: true },
)

it.instance(
  "persists the pattern the user was shown, not the tool-authored wildcard",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_shown"),
        sessionID: SessionID.make("session_shown"),
        permission: "task",
        patterns: ["goal-reviewer"],
        metadata: {},
        // what the task tool authors
        always: ["*"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_shown"), reply: "always" })
      yield* Fiber.join(fiber)

      // in-run the tool wildcard still applies
      expect((yield* grants()).map((rule) => rule.pattern)).toContain("*")

      yield* store.reload({ directory: test.directory })

      // after a restart only the shown pattern survived
      expect(yield* grants()).toEqual([{ permission: "task", pattern: "goal-reviewer", action: "allow" }])
      expect(
        yield* askOrPending({
          sessionID: SessionID.make("session_shown_2"),
          permission: "task",
          patterns: ["some-other-agent"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      ).toBe("pending")
    }),
  { git: true },
)

it.live("a persisted grant is scoped to its project", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped({ git: true })
    const two = yield* tmpdirScoped({ git: true })
    const store = yield* InstanceStore.Service

    const fiber = yield* store
      .provide(
        { directory: one },
        ask({
          id: PermissionV1.ID.make("per_scope"),
          sessionID: SessionID.make("session_scope"),
          permission: "bash",
          patterns: ["rm -rf node_modules"],
          metadata: {},
          always: ["rm *"],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      )
      .pipe(Effect.forkScoped)
    yield* store.provide({ directory: one }, waitForPending(1))
    yield* store.provide({ directory: one }, reply({ requestID: PermissionV1.ID.make("per_scope"), reply: "always" }))
    yield* Fiber.join(fiber)

    // same project, fresh instance: grant applies
    yield* store.reload({ directory: one })
    expect(
      yield* store.provide(
        { directory: one },
        askOrPending({
          sessionID: SessionID.make("session_scope_same"),
          permission: "bash",
          patterns: ["rm -rf node_modules"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ),
    ).toBe("resolved")

    // unrelated project: still asks
    expect(
      yield* store.provide(
        { directory: two },
        askOrPending({
          sessionID: SessionID.make("session_scope_other"),
          permission: "bash",
          patterns: ["rm -rf node_modules"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ),
    ).toBe("pending")
    expect(yield* store.provide({ directory: two }, grants())).toEqual([])
  }),
)

it.instance(
  "permission_persist false keeps grants to the current run",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_optout"),
        sessionID: SessionID.make("session_optout"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_optout"), reply: "always" })
      yield* Fiber.join(fiber)

      // still granted for this run
      expect(yield* grants()).not.toEqual([])

      yield* store.reload({ directory: test.directory })
      expect(yield* grants()).toEqual([])
      expect(
        yield* askOrPending({
          sessionID: SessionID.make("session_optout_2"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("pending")
    }),
  { git: true, config: { permission_persist: false } },
)

it.instance(
  "revoke drops a grant from memory and from the store",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_revoke"),
        sessionID: SessionID.make("session_revoke"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_revoke"), reply: "always" })
      yield* Fiber.join(fiber)

      const removed = yield* Permission.Service.use((p) => p.revoke({ permission: "bash" }))
      expect(removed).toBeGreaterThan(0)
      expect(yield* grants()).toEqual([])

      yield* store.reload({ directory: test.directory })
      expect(yield* grants()).toEqual([])
    }),
  { git: true },
)

// ---------------------------------------------------------------------------
// auto mode
// ---------------------------------------------------------------------------

it.instance(
  "auto mode turns ask into allow without asking",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session_auto")
      expect((yield* setAuto(sessionID, true)).enabled).toBe(true)
      expect(
        yield* askOrPending({
          sessionID,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("resolved")
      expect(yield* Permission.Service.use((p) => p.list())).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "auto mode never turns an explicit deny into allow",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session_auto_deny")
      yield* setAuto(sessionID, true)
      const exit = yield* ask({
        sessionID,
        permission: "bash",
        patterns: ["rm -rf /"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "rm *", action: "deny" }],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("PermissionDeniedError")
    }),
  { git: true },
)

it.instance(
  "auto mode grants nothing permanent and leaves nothing behind when turned off",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const sessionID = SessionID.make("session_auto_clean")
      yield* setAuto(sessionID, true)
      yield* ask({
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["*"],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      expect(yield* grants()).toEqual([])

      expect((yield* setAuto(sessionID, false)).enabled).toBe(false)
      expect(yield* grants()).toEqual([])
      expect(
        yield* askOrPending({
          sessionID,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("pending")

      yield* store.reload({ directory: test.directory })
      expect(yield* grants()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "auto mode records an audit trail",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session_auto_audit")
      yield* setAuto(sessionID, true)
      yield* ask({
        sessionID,
        permission: "bash",
        patterns: ["git push"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      const log = yield* autoLog()
      expect(log).toHaveLength(1)
      expect(log[0]!.permission).toBe("bash")
      expect(log[0]!.pattern).toBe("git push")
      expect(log[0]!.sessionID).toBe(sessionID)
      expect(log[0]!.time).toBeGreaterThan(0)
    }),
  { git: true },
)

it.instance(
  "auto mode survives an instance reload (resume/continue)",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const sessionID = SessionID.make("session_auto_resume")
      yield* setAuto(sessionID, true)

      yield* store.reload({ directory: test.directory })

      expect((yield* getAuto(sessionID)).enabled).toBe(true)
      expect(
        yield* askOrPending({
          sessionID,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("resolved")
    }),
  { git: true },
)

it.instance(
  "enabling auto releases requests already pending in the session",
  () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session_auto_drain")
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_auto_drain"),
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* setAuto(sessionID, true)
      yield* Fiber.join(fiber)
      expect(yield* Permission.Service.use((p) => p.list())).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "a subagent session inherits auto mode from its parent",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "goal reviewer" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "nested" })

      expect((yield* getAuto(child.id)).enabled).toBe(false)
      yield* setAuto(parent.id, true)

      const childStatus = yield* getAuto(child.id)
      expect(childStatus.enabled).toBe(true)
      expect(childStatus.explicit).toBe(false)
      expect(childStatus.source).toBe(parent.id)
      // memoized answers stay identical
      expect(yield* getAuto(child.id)).toEqual(childStatus)
      expect((yield* getAuto(grandchild.id)).enabled).toBe(true)

      // the reviewer does not re-ask
      expect(
        yield* askOrPending({
          sessionID: child.id,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("resolved")

      // turning it off at the parent propagates back down
      yield* setAuto(parent.id, false)
      expect((yield* getAuto(child.id)).enabled).toBe(false)
    }),
  { git: true },
)

it.instance(
  "auto mode on a parent releases a pending subagent request",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "goal reviewer" })

      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_auto_child"),
        sessionID: child.id,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* setAuto(parent.id, true)
      yield* Fiber.join(fiber)
      expect(yield* Permission.Service.use((p) => p.list())).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "auto mode is per session, not process wide",
  () =>
    Effect.gen(function* () {
      const auto = SessionID.make("session_auto_only")
      const manual = SessionID.make("session_manual")
      yield* setAuto(auto, true)
      expect(
        yield* askOrPending({
          sessionID: manual,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }),
      ).toBe("pending")
    }),
  { git: true },
)
