import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionGoal } from "@/session/goal"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([SessionGoal.node, Storage.node, EventV2Bridge.node, FSUtil.node, CrossSpawnSpawner.node]),
  ),
)

const setup = Effect.fnUntraced(function* () {
  const goal = yield* SessionGoal.Service
  const sessionID = SessionID.create()
  yield* Effect.addFinalizer(() => goal.clear(sessionID).pipe(Effect.ignore))
  return { goal, sessionID }
})

describe("SessionGoal", () => {
  it.live("publishes terminal and budget lifecycle transitions once", () =>
    Effect.gen(function* () {
      const goal = yield* SessionGoal.Service
      const events = yield* EventV2Bridge.Service
      const seen: { type: string; data: unknown }[] = []
      const unsubscribe = yield* events.listen((event) => {
        if (event.type.startsWith("session.goal.")) seen.push({ type: event.type, data: event.data })
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const completedID = SessionID.create()
      yield* Effect.addFinalizer(() => goal.clear(completedID).pipe(Effect.ignore))
      yield* goal.set({ sessionID: completedID, objective: "complete with an event" })
      yield* goal.requestReview({ sessionID: completedID })
      const reviewerID = SessionID.create()
      yield* goal.beginReview(completedID, reviewerID)
      yield* goal.finishReview({
        sessionID: completedID,
        reviewerSessionID: reviewerID,
        accepted: true,
        reason: "verified",
        tokens: 0,
      })
      yield* goal.finishReview({
        sessionID: completedID,
        reviewerSessionID: reviewerID,
        accepted: true,
        reason: "duplicate",
        tokens: 0,
      })

      const blockedID = SessionID.create()
      yield* Effect.addFinalizer(() => goal.clear(blockedID).pipe(Effect.ignore))
      yield* goal.set({ sessionID: blockedID, objective: "block with an event" })
      yield* goal.block(blockedID, "missing credential")
      yield* goal.recordTurn({ sessionID: blockedID, tokens: 0 })
      yield* goal.block(blockedID, "missing credential")
      yield* goal.recordTurn({ sessionID: blockedID, tokens: 0 })
      yield* goal.block(blockedID, "missing credential")
      yield* goal.block(blockedID, "missing credential")

      const pausedID = SessionID.create()
      yield* Effect.addFinalizer(() => goal.clear(pausedID).pipe(Effect.ignore))
      yield* goal.set({ sessionID: pausedID, objective: "pause with an event", tokenBudget: 10 })
      yield* goal.recordTurn({ sessionID: pausedID, tokens: 10 })
      yield* goal.recordTurn({ sessionID: pausedID, tokens: 10 })

      expect(seen).toEqual([
        { type: "session.goal.completed", data: { sessionID: completedID } },
        { type: "session.goal.blocked", data: { sessionID: blockedID, reason: "missing credential" } },
        {
          type: "session.goal.paused",
          data: { sessionID: pausedID, reason: "budget", tokenBudget: 10, tokensUsed: 10 },
        },
      ])
    }),
  )

  it.live("persists lifecycle state and preserves usage across edits", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()

      const created = yield* goal.set({ sessionID, objective: "  ship the feature  ", tokenBudget: 5_000 })
      expect(created.objective).toBe("ship the feature")
      expect(created.status).toBe("active")
      expect(created.tokensUsed).toBe(0)
      expect(yield* goal.context(sessionID)).toContain("Objective: ship the feature")

      yield* goal.recordTurn({ sessionID, tokens: 125 })
      const paused = yield* goal.pause(sessionID)
      expect(paused?.status).toBe("paused")
      expect(paused?.pauseReason).toBe("user")

      const resumed = yield* goal.resume(sessionID)
      expect(resumed?.status).toBe("active")
      expect(resumed?.time.running).toBeNumber()

      const edited = yield* goal.edit({ sessionID, objective: "ship and verify" })
      expect(edited?.objective).toBe("ship and verify")
      expect(edited?.tokensUsed).toBe(125)
      expect(edited?.turns).toBe(1)
      expect(edited?.tokenBudget).toBe(5_000)

      yield* goal.requestReview({ sessionID, evidence: "Lifecycle verification passed." })
      const reviewerID = SessionID.create()
      yield* goal.beginReview(sessionID, reviewerID)
      const completed = yield* goal.finishReview({
        sessionID,
        reviewerSessionID: reviewerID,
        accepted: true,
        reason: "Lifecycle verification independently accepted.",
        tokens: 0,
      })
      expect(completed?.status).toBe("complete")
      expect(completed?.time.completed).toBeNumber()
      expect((yield* goal.resume(sessionID))?.status).toBe("complete")

      expect(yield* goal.clear(sessionID)).toBe(true)
      expect(yield* goal.get(sessionID)).toBeUndefined()
      expect(yield* goal.clear(sessionID)).toBe(false)
    }),
  )

  it.live("requires the same blocker on three consecutive goal turns", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      const created = yield* goal.set({ sessionID, objective: "finish despite blockers" })
      expect(Object.hasOwn(created, "tokenBudget")).toBe(false)
      const edited = yield* goal.edit({ sessionID, objective: "finish despite every blocker" })
      expect(Object.hasOwn(edited!, "tokenBudget")).toBe(false)

      expect((yield* goal.block(sessionID, "missing credential"))?.blocker?.count).toBe(1)
      expect((yield* goal.block(sessionID, "missing credential"))?.blocker?.count).toBe(1)
      yield* goal.recordTurn({ sessionID, tokens: 10 })

      expect((yield* goal.block(sessionID, "missing credential"))?.blocker?.count).toBe(2)
      yield* goal.recordTurn({ sessionID, tokens: 10 })

      const blocked = yield* goal.block(sessionID, "missing credential")
      expect(blocked?.blocker?.count).toBe(3)
      expect(blocked?.status).toBe("blocked")
      expect(blocked?.time.running).toBeUndefined()
    }),
  )

  it.live("resets a non-consecutive blocker and pauses at the token budget", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "bounded work", tokenBudget: 100 })

      yield* goal.block(sessionID, "network unavailable")
      yield* goal.recordTurn({ sessionID, tokens: 40 })
      yield* goal.recordTurn({ sessionID, tokens: 60 })

      const paused = yield* goal.get(sessionID)
      expect(paused?.status).toBe("paused")
      expect(paused?.pauseReason).toBe("budget")
      expect(paused?.tokensUsed).toBe(100)
      expect(paused?.blocker).toBeUndefined()

      expect(yield* goal.context(sessionID)).toBeUndefined()
    }),
  )

  it.live("records and clears interrupted turns without mutating stable context", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "survive a flaky provider" })
      const stable = yield* goal.context(sessionID)

      yield* goal.recordTurn({ sessionID, tokens: 0, interrupted: "Provider is overloaded" })
      const first = yield* goal.get(sessionID)
      expect(first?.interrupted?.reason).toBe("Provider is overloaded")
      expect(first?.interrupted?.count).toBe(1)

      const context = yield* goal.context(sessionID)
      expect(context).toBe(stable)
      expect(context).toContain("interruption details arrive in each goal continuation turn message")
      expect(context).not.toContain("Provider is overloaded")
      expect(context).not.toContain("Elapsed:")

      yield* goal.recordTurn({ sessionID, tokens: 0, interrupted: "Provider is overloaded" })
      const second = yield* goal.get(sessionID)
      expect(second?.interrupted?.count).toBe(2)
      expect(yield* goal.context(sessionID)).toBe(stable)

      // A turn that ends normally clears the note.
      yield* goal.recordTurn({ sessionID, tokens: 12 })
      const recovered = yield* goal.get(sessionID)
      expect(recovered?.interrupted).toBeUndefined()
      expect(yield* goal.context(sessionID)).toBe(stable)
    }),
  )

  it.live("verdicts are bound to the running reviewer, write-once, and cleared on recovery", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "structured verdict lifecycle" })
      yield* goal.requestReview({ sessionID, evidence: "attempt one" })
      const reviewerID = SessionID.create()
      yield* goal.beginReview(sessionID, reviewerID)

      // A verdict from a session that is not the running reviewer is ignored.
      const forged = yield* goal.submitVerdict({
        sessionID,
        reviewerSessionID: SessionID.create(),
        met: true,
        summary: "forged",
      })
      expect(forged?.review?.verdict).toBeUndefined()

      // First write wins; a second call cannot overwrite it.
      yield* goal.submitVerdict({ sessionID, reviewerSessionID: reviewerID, met: false, summary: "first verdict" })
      const overwritten = yield* goal.submitVerdict({
        sessionID,
        reviewerSessionID: reviewerID,
        met: true,
        summary: "second verdict",
      })
      expect(overwritten?.review?.verdict?.summary).toBe("first verdict")
      expect(overwritten?.review?.verdict?.met).toBe(false)

      // Recovery discards the interrupted reviewer's verdict so it cannot leak
      // into the replacement reviewer's attempt.
      const recovered = yield* goal.recoverReview(sessionID)
      expect(recovered?.review?.verdict).toBeUndefined()
      const replacementID = SessionID.create()
      const begun = yield* goal.beginReview(sessionID, replacementID)
      expect(begun?.review?.verdict).toBeUndefined()
    }),
  )

  it.live("the requirement checklist is write-once, reviewer-bound, and cleared by an objective edit", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "ship two independently verifiable things" })
      yield* goal.requestReview({ sessionID })
      const reviewerID = SessionID.create()
      yield* goal.beginReview(sessionID, reviewerID)

      // A session that is not the running reviewer cannot write the checklist.
      const forged = yield* goal.recordRequirements({
        sessionID,
        reviewerSessionID: SessionID.create(),
        requirements: [{ id: "R1", text: "forged" }],
      })
      expect(forged?.requirements).toBeUndefined()

      const first = yield* goal.recordRequirements({
        sessionID,
        reviewerSessionID: reviewerID,
        requirements: [
          { id: "R1", text: "the exporter exists" },
          { id: "R2", text: "the exporter is covered by tests" },
        ],
      })
      expect(first?.requirements?.map((item) => item.id)).toEqual(["R1", "R2"])
      expect(first?.requirements?.every((item) => item.status === "unverified" && item.attempt === 0)).toBe(true)

      // First write wins, exactly like submitVerdict.
      const second = yield* goal.recordRequirements({
        sessionID,
        reviewerSessionID: reviewerID,
        requirements: [{ id: "R1", text: "a narrower objective" }],
      })
      expect(second?.requirements?.map((item) => item.text)).toEqual([
        "the exporter exists",
        "the exporter is covered by tests",
      ])

      // A new objective invalidates the decomposition of the old one.
      const edited = yield* goal.edit({ sessionID, objective: "ship something else entirely" })
      expect(edited?.requirements).toBeUndefined()
      expect(edited?.review).toBeUndefined()
    }),
  )

  it.live("per-requirement verdicts fold into durable state and carry to the next attempt", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "two requirements, one attempt each" })
      yield* goal.requestReview({ sessionID })
      const firstReviewer = SessionID.create()
      yield* goal.beginReview(sessionID, firstReviewer)
      yield* goal.recordRequirements({
        sessionID,
        reviewerSessionID: firstReviewer,
        requirements: [
          { id: "R1", text: "the exporter exists" },
          { id: "R2", text: "the exporter is covered by tests" },
        ],
      })
      yield* goal.submitVerdict({
        sessionID,
        reviewerSessionID: firstReviewer,
        met: false,
        summary: "one of two",
        unmet: [{ requirement: "tests", evidence: "no test file exists" }],
        requirements: [
          { id: "R1", status: "met", evidence: "src/exporter.ts defines it" },
          { id: "R2", status: "unmet", evidence: "no exporter.test.ts on disk" },
          // An id that is not on the checklist is dropped, never invented.
          { id: "R9", status: "met", evidence: "phantom" },
        ],
      })
      const folded = yield* goal.get(sessionID)
      expect(folded?.requirements).toHaveLength(2)
      expect(folded?.requirements?.[0]).toMatchObject({
        id: "R1",
        status: "met",
        evidence: "src/exporter.ts defines it",
        attempt: 1,
      })
      expect(folded?.requirements?.[1]).toMatchObject({ id: "R2", status: "unmet", attempt: 1 })
      // The id-less unmet[] array keeps working alongside it.
      expect(folded?.review?.verdict?.unmet).toHaveLength(1)

      yield* goal.finishReview({
        sessionID,
        reviewerSessionID: firstReviewer,
        accepted: false,
        reason: "R2 is unmet",
        tokens: 5,
      })
      // Conclusions, not sessions, are what carries forward.
      const next = yield* goal.requestReview({ sessionID })
      expect(next?.requirements?.map((item) => item.status)).toEqual(["met", "unmet"])
    }),
  )

  it.live("records measured per-attempt reviewer cost", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "measure the reviewer" })
      yield* goal.requestReview({ sessionID })
      const reviewerID = SessionID.create()
      yield* goal.beginReview(sessionID, reviewerID)
      const finished = yield* goal.finishReview({
        sessionID,
        reviewerSessionID: reviewerID,
        accepted: true,
        reason: "verified",
        tokens: 58,
        stats: {
          inputTokens: 9_000,
          cacheReadTokens: 4_000,
          outputTokens: 58,
          retrievalCalls: 3,
          durationMs: 12_345,
        },
      })
      expect(finished?.review?.attemptStats).toHaveLength(1)
      expect(finished?.review?.attemptStats?.[0]).toMatchObject({
        attempt: 1,
        inputTokens: 9_000,
        cacheReadTokens: 4_000,
        outputTokens: 58,
        retrievalCalls: 3,
      })
      // The budget stays generated-tokens-only; prompt/cache tokens are stats.
      expect(finished?.tokensUsed).toBe(58)
    }),
  )

  it.live("tracks consecutive reminders and resets them on review request and finish", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "finish after programmatic reminders" })

      expect((yield* goal.recordReminder(sessionID))?.reminderStreak).toBe(1)
      expect((yield* goal.recordReminder(sessionID))?.reminderStreak).toBe(2)
      expect((yield* goal.requestReview({ sessionID }))?.reminderStreak).toBe(0)

      const reviewerID = SessionID.create()
      yield* goal.beginReview(sessionID, reviewerID)
      yield* goal.recordReminder(sessionID)
      expect((yield* goal.get(sessionID))?.reminderStreak).toBe(1)
      const finished = yield* goal.finishReview({
        sessionID,
        reviewerSessionID: reviewerID,
        accepted: false,
        reason: "one requirement remains",
        tokens: 0,
      })
      expect(finished?.reminderStreak).toBe(0)
    }),
  )

  it.live("decodes a goal row written before requirements and attemptStats existed", () =>
    Effect.gen(function* () {
      const goal = yield* SessionGoal.Service
      const storage = yield* Storage.Service
      const sessionID = SessionID.create()
      yield* Effect.addFinalizer(() => goal.clear(sessionID).pipe(Effect.ignore))
      const now = Date.now()
      // Verbatim shape of a pre-tranche stored row.
      yield* storage.write(["goal", sessionID], {
        sessionID,
        objective: "a goal stored before this tranche",
        status: "active",
        tokensUsed: 120,
        turns: 3,
        review: {
          status: "rejected",
          attempt: 2,
          requestedAt: now - 1000,
          updatedAt: now,
          reason: "not yet",
          errorStreak: 0,
          verdict: { met: false, summary: "no", unmet: [{ requirement: "a", evidence: "b" }], at: now },
          history: [{ attempt: 1, reason: "first rejection", at: now - 500 }],
        },
        time: { created: now - 5000, updated: now, running: now, elapsed: 1000 },
      })

      const loaded = yield* goal.get(sessionID)
      expect(loaded?.objective).toBe("a goal stored before this tranche")
      expect(loaded?.requirements).toBeUndefined()
      expect(loaded?.reminderStreak).toBeUndefined()
      expect(loaded?.review?.attemptStats).toBeUndefined()
      expect(loaded?.review?.history).toHaveLength(1)
      // And it stays writable through the new code paths.
      const turned = yield* goal.recordTurn({ sessionID, tokens: 1 })
      expect(turned?.turns).toBe(4)
    }),
  )

  it.live("history records substantive rejections but not infrastructure errors", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "history hygiene" })

      yield* goal.requestReview({ sessionID })
      const first = SessionID.create()
      yield* goal.beginReview(sessionID, first)
      const errored = yield* goal.finishReview({
        sessionID,
        reviewerSessionID: first,
        accepted: false,
        error: true,
        reason: "Independent reviewer timed out after 120s without activity",
        tokens: 0,
      })
      expect(errored?.review?.errorStreak).toBe(1)
      expect(errored?.review?.history ?? []).toHaveLength(0)

      yield* goal.requestReview({ sessionID })
      const second = SessionID.create()
      yield* goal.beginReview(sessionID, second)
      const rejected = yield* goal.finishReview({
        sessionID,
        reviewerSessionID: second,
        accepted: false,
        reason: "The second requirement is unimplemented.",
        tokens: 9,
      })
      // A real verdict resets the error streak; the rejection enters history.
      expect(rejected?.review?.errorStreak).toBe(0)
      expect(rejected?.review?.history).toHaveLength(1)
      expect(rejected?.review?.history?.[0]?.reason).toContain("second requirement")
    }),
  )

  it.live("a successful mid-turn tool step does not reset the interruption streak", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "streak survives partial progress" })

      yield* goal.recordTurn({ sessionID, tokens: 0, interrupted: "stream died", completed: true })
      expect((yield* goal.get(sessionID))?.interrupted?.count).toBe(1)
      // A tool step that succeeded before the provider died again.
      yield* goal.recordTurn({ sessionID, tokens: 40, completed: false })
      expect((yield* goal.get(sessionID))?.interrupted?.count).toBe(1)
      yield* goal.recordTurn({ sessionID, tokens: 0, interrupted: "stream died again", completed: true })
      expect((yield* goal.get(sessionID))?.interrupted?.count).toBe(2)
      // Only a clean completed turn ends the outage.
      yield* goal.recordTurn({ sessionID, tokens: 12, completed: true })
      expect((yield* goal.get(sessionID))?.interrupted).toBeUndefined()
    }),
  )

  it.live("only completes after an independent review accepts current-state evidence", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "ship and independently verify the feature" })
      const stable = yield* goal.context(sessionID)

      const first = yield* goal.requestReview({ sessionID, evidence: "Worker claims the feature is done." })
      expect(first?.status).toBe("active")
      expect(first?.review?.status).toBe("pending")
      expect(first?.review?.attempt).toBe(1)

      const reviewerID = SessionID.create()
      expect((yield* goal.beginReview(sessionID, reviewerID))?.review?.status).toBe("running")
      const rejected = yield* goal.finishReview({
        sessionID,
        reviewerSessionID: reviewerID,
        accepted: false,
        reason: "The normal TUI has not been verified.",
        tokens: 17,
      })
      expect(rejected?.status).toBe("active")
      expect(rejected?.review?.status).toBe("rejected")
      expect(rejected?.tokensUsed).toBe(17)
      // Review state DOES belong in the stable block, and this is the reason:
      // when a worker requests completion through the goal tool the loop keeps
      // going inside the same turn, so no continuation message is produced and
      // the reviewer's rejection would otherwise reach the model nowhere at
      // all. It costs one cache miss per review, not one per request — the
      // turn/token/elapsed counters are what had to move out, and the
      // stability of the block across those is asserted above.
      const afterRejection = yield* goal.context(sessionID)
      expect(afterRejection).toContain("The normal TUI has not been verified.")
      expect(afterRejection).toContain("did not accept completion")
      // Still stable across pure accounting churn.
      yield* goal.recordTurn({ sessionID, tokens: 0 })
      expect(yield* goal.context(sessionID)).toBe(afterRejection)

      const second = yield* goal.requestReview({ sessionID, evidence: "Normal TUI evidence is now attached." })
      expect(second?.review?.attempt).toBe(2)
      const secondReviewerID = SessionID.create()
      yield* goal.beginReview(sessionID, secondReviewerID)
      const recovered = yield* goal.recoverReview(sessionID)
      expect(recovered?.status).toBe("active")
      expect(recovered?.review?.status).toBe("pending")
      expect(recovered?.review?.attempt).toBe(2)
      expect(recovered?.review?.reviewerSessionID).toBeUndefined()
      expect(recovered?.review?.reason).toContain("interrupted")

      const replacementReviewerID = SessionID.create()
      yield* goal.beginReview(sessionID, replacementReviewerID)
      const accepted = yield* goal.finishReview({
        sessionID,
        reviewerSessionID: replacementReviewerID,
        accepted: true,
        reason: "All explicit requirements were verified from current state.",
        tokens: 23,
      })
      expect(accepted?.status).toBe("complete")
      expect(accepted?.review?.status).toBe("accepted")
      expect(accepted?.tokensUsed).toBe(40)
      expect(accepted?.time.completed).toBeNumber()
    }),
  )
})
