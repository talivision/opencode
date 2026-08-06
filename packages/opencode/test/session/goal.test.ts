import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { SessionGoal } from "@/session/goal"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionGoal.node, Storage.node, FSUtil.node, CrossSpawnSpawner.node])),
)

const setup = Effect.fnUntraced(function* () {
  const goal = yield* SessionGoal.Service
  const sessionID = SessionID.create()
  yield* Effect.addFinalizer(() => goal.clear(sessionID).pipe(Effect.ignore))
  return { goal, sessionID }
})

describe("SessionGoal", () => {
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

  it.live("records an interrupted turn and tells the worker to resume, then clears it", () =>
    Effect.gen(function* () {
      const { goal, sessionID } = yield* setup()
      yield* goal.set({ sessionID, objective: "survive a flaky provider" })

      yield* goal.recordTurn({ sessionID, tokens: 0, interrupted: "Provider is overloaded" })
      const first = yield* goal.get(sessionID)
      expect(first?.interrupted?.reason).toBe("Provider is overloaded")
      expect(first?.interrupted?.count).toBe(1)

      const context = yield* goal.context(sessionID)
      expect(context).toContain("ended before you completed it: Provider is overloaded")
      expect(context).toContain("no independent review was run")
      expect(context).toContain("Resume the objective from current state")
      // A run that never completed must not read as a rejected completion.
      expect(context).toContain("No independent completion review is pending.")

      yield* goal.recordTurn({ sessionID, tokens: 0, interrupted: "Provider is overloaded" })
      const second = yield* goal.get(sessionID)
      expect(second?.interrupted?.count).toBe(2)
      expect(yield* goal.context(sessionID)).toContain("2 consecutive interrupted turns")

      // A turn that ends normally clears the note.
      yield* goal.recordTurn({ sessionID, tokens: 12 })
      const recovered = yield* goal.get(sessionID)
      expect(recovered?.interrupted).toBeUndefined()
      expect(yield* goal.context(sessionID)).not.toContain("ended before you completed it")
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
      expect(yield* goal.context(sessionID)).toContain("The normal TUI has not been verified.")

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
