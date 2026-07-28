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
