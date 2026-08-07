import { Effect, Schema } from "effect"
import { SessionGoal } from "@/session/goal"
import { Session } from "@/session/session"
import { define, type DefWithoutID } from "./tool"

export const Parameters = Schema.Struct({
  met: Schema.Boolean.annotate({
    description: "Whether every explicit requirement of the goal objective is satisfied in current system state",
  }),
  summary: Schema.String.annotate({
    description: "One short paragraph naming the decisive evidence for the verdict",
  }),
  unmet: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          requirement: Schema.String.annotate({ description: "The specific requirement that is not satisfied" }),
          evidence: Schema.String.annotate({
            description: "What you inspected that shows it is missing or incomplete",
          }),
        }),
      ),
    ),
  ).annotate({ description: "Every unmet requirement, with evidence. Required when met is false." }),
  requirements: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          id: Schema.String.annotate({ description: "Checklist requirement id, e.g. R1" }),
          status: Schema.Literals(["met", "unmet"]).annotate({
            description: "Whether this specific requirement is satisfied in current state",
          }),
          evidence: Schema.optional(Schema.String).annotate({
            description: "The authoritative artifact you inspected for this requirement",
          }),
        }),
      ),
    ),
  ).annotate({
    description:
      "Per-requirement roll-up against the goal checklist. Ids must come from the checklist in your first message. Carried forward to the next reviewer.",
  }),
})

type Metadata = {
  met?: boolean
  unmet?: number
  requirements?: number
}

export const GoalVerdictTool = define<typeof Parameters, Metadata, SessionGoal.Service | Session.Service>(
  "goal_verdict",
  Effect.gen(function* () {
    const goal = yield* SessionGoal.Service
    const sessions = yield* Session.Service

    return {
      description: [
        "Submit your final verdict on whether the goal objective is met.",
        "Call this exactly once, at the end of your review, after inspecting authoritative current state.",
        "When met is false, list every unmet requirement with the evidence that shows it is unmet — the worker only sees what you put here, so vague summaries produce another wasted attempt.",
      ].join(" "),
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const self = yield* sessions.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          const parentID = self?.parentID
          if (!parentID) {
            return {
              title: "No goal review in progress",
              output: "This session is not a goal review session; the verdict was not recorded.",
              metadata: {},
            }
          }
          const unmet = (params.unmet ?? []).filter(
            (item) => item.requirement.trim().length > 0 && item.evidence.trim().length > 0,
          )
          if (params.met === false && unmet.length === 0) {
            return {
              title: "Unmet requirements missing",
              output:
                "A not-met verdict must list every unmet requirement with non-empty evidence. Call goal_verdict again with the unmet array filled in.",
              metadata: {},
            }
          }
          if (params.met === true && unmet.length > 0) {
            return {
              title: "Contradictory verdict",
              output:
                "A met verdict cannot carry unmet requirements. Resolve the contradiction and call goal_verdict again: met false with the unmet list, or met true with an empty list.",
              metadata: {},
            }
          }
          if (!params.summary.trim()) {
            return {
              title: "Summary missing",
              output: "The summary must name the decisive evidence. Call goal_verdict again with a non-empty summary.",
              metadata: {},
            }
          }
          // Per-requirement results are optional and additive: the id-less
          // unmet[] array and the nonce text fallback both keep working.
          const checklist = (yield* goal.get(parentID))?.requirements ?? []
          const requirements = (params.requirements ?? []).filter((item) => item.id.trim().length > 0)
          const unknown = requirements.filter((item) => !checklist.some((entry) => entry.id === item.id.trim()))
          if (unknown.length > 0) {
            return {
              title: "Unknown requirement ids",
              output: checklist.length
                ? `These ids are not on this goal's checklist: ${unknown.map((item) => item.id).join(", ")}. Valid ids: ${checklist
                    .map((item) => item.id)
                    .join(", ")}. Call goal_verdict again.`
                : "This goal has no checklist, so per-requirement results cannot be recorded. Call goal_verdict again without the requirements array.",
              metadata: {},
            }
          }
          const updated = yield* goal.submitVerdict({
            sessionID: parentID,
            reviewerSessionID: ctx.sessionID,
            met: params.met,
            summary: params.summary.trim(),
            ...(unmet.length ? { unmet } : {}),
            ...(requirements.length
              ? {
                  requirements: requirements.map((item) => ({
                    id: item.id.trim(),
                    status: item.status,
                    ...(item.evidence?.trim() ? { evidence: item.evidence.trim() } : {}),
                  })),
                }
              : {}),
          })
          if (updated?.review?.verdict === undefined) {
            return {
              title: "Verdict not recorded",
              output:
                "No running review names this session as its reviewer; the verdict was ignored. Do not retry.",
              metadata: {},
            }
          }
          return {
            title: params.met ? "Verdict recorded: met" : "Verdict recorded: not met",
            output: "Verdict recorded. Finish your final message with a one-line restatement of the decision.",
            metadata: { met: params.met, unmet: params.unmet?.length ?? 0, requirements: requirements.length },
          }
        }),
    } satisfies DefWithoutID<typeof Parameters, Metadata>
  }),
)
