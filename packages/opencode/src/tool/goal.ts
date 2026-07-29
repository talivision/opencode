import { Effect, Schema } from "effect"
import { SessionGoal } from "@/session/goal"
import { define, type DefWithoutID } from "./tool"

export const Parameters = Schema.Struct({
  status: Schema.Literals(["complete", "blocked"]).annotate({
    description: "The terminal state to request for the active goal",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description:
      "Verification evidence when requesting completion, or the repeated blocking condition when requesting blocked",
  }),
})

type Metadata = {
  status?: SessionGoal.Status
  objective?: string
  blockerCount?: number
  reviewStatus?: SessionGoal.ReviewStatus
  reviewAttempt?: number
}

export const GoalTool = define<typeof Parameters, Metadata, SessionGoal.Service>(
  "goal",
  Effect.gen(function* () {
    const goal = yield* SessionGoal.Service

    return {
      description: [
        "Update the active long-running goal.",
        "Call with complete only after every requirement has been implemented and you have gathered current-state evidence.",
        "A complete call requests an independent read-only review; it does not directly complete the goal.",
        "Call with blocked only after the same unavoidable blocker has persisted for at least three consecutive goal turns.",
        "Do not use this tool merely because work is difficult, incomplete, or approaching a token budget.",
      ].join(" "),
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const current = yield* goal.get(ctx.sessionID)
          if (!current) {
            return {
              title: "No active goal",
              output: "No goal is set for this session. Continue responding to the user normally.",
              metadata: {},
            }
          }
          if (current.status !== "active") {
            return {
              title: `Goal ${current.status}`,
              output: `The goal is ${current.status}; its state was not changed.`,
              metadata: {
                status: current.status,
                objective: current.objective,
                blockerCount: current.blocker?.count,
              },
            }
          }

          if (params.status === "complete") {
            const updated = yield* goal.requestReview({
              sessionID: ctx.sessionID,
              ...(params.reason?.trim() ? { evidence: params.reason.trim() } : {}),
            })
            return {
              title: "Goal review requested",
              output:
                "Completion is pending independent review. Finish this turn with the strongest verification evidence; OpenCode will continue automatically if the reviewer rejects the request.",
              metadata: {
                status: updated?.status,
                objective: updated?.objective,
                reviewStatus: updated?.review?.status,
                reviewAttempt: updated?.review?.attempt,
              },
            }
          }

          const reason = params.reason?.trim()
          if (!reason) {
            return {
              title: "Blocking reason required",
              output: "Provide the exact repeated blocking condition before requesting blocked status.",
              metadata: {
                status: current.status,
                objective: current.objective,
                blockerCount: current.blocker?.count,
              },
            }
          }

          const updated = yield* goal.block(ctx.sessionID, reason)
          const accepted = updated?.status === "blocked"
          return {
            title: accepted ? "Goal blocked" : "Blocker recorded",
            output: accepted
              ? "Goal marked blocked after three consecutive reports of the same blocker. Explain what external change is required."
              : `Blocker recorded ${updated?.blocker?.count ?? 1}/3. Keep pursuing safe alternatives and meaningful progress.`,
            metadata: {
              status: updated?.status,
              objective: updated?.objective,
              blockerCount: updated?.blocker?.count,
            },
          }
        }),
    } satisfies DefWithoutID<typeof Parameters, Metadata>
  }),
)
