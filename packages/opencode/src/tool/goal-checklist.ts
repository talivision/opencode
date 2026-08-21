import { Effect, Schema } from "effect"
import { SessionGoal } from "@/session/goal"
import { Session } from "@/session/session"
import { define, type DefWithoutID } from "./tool"

export const Parameters = Schema.Struct({
  requirements: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String.annotate({ description: "Stable identifier: R1, R2, R3, ... in objective order" }),
        text: Schema.String.annotate({
          description: "One explicit, independently checkable requirement, quoted or closely paraphrased",
        }),
      }),
    ),
  ).annotate({
    description: "Every explicit requirement in the objective, decomposed into independently verifiable items",
  }),
  revised_because: Schema.optional(Schema.String).annotate({
    description:
      "Only when replacing an inherited checklist that clearly misinterprets the objective: what exactly was misread. Without this, an existing checklist is never replaced.",
  }),
})

type Metadata = {
  recorded?: number
  existing?: number
}

const ID_PATTERN = /^R[1-9][0-9]*$/

export const GoalChecklistTool = define<typeof Parameters, Metadata, SessionGoal.Service | Session.Service>(
  "goal_checklist",
  Effect.gen(function* () {
    const goal = yield* SessionGoal.Service
    const sessions = yield* Session.Service

    return {
      description: [
        "Record the requirement checklist for this goal — the decomposition of the objective into independently verifiable requirements, ids R1..Rn.",
        "The first reviewer creates it and every later reviewer inherits it as the stable frame of reference.",
        "Call this before gathering evidence if your first message says the checklist is missing.",
        "If the inherited checklist clearly misinterprets the objective, call with revised_because stating the misreading to replace it; otherwise never replace it.",
      ].join(" "),
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          // Same parent resolution as goal_verdict: no sessionID parameter, so
          // one goal's reviewer can never write another goal's checklist.
          const self = yield* sessions.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          const parentID = self?.parentID
          if (!parentID) {
            return {
              title: "No goal review in progress",
              output: "This session is not a goal review session; the checklist was not recorded. Do not retry.",
              metadata: {},
            }
          }
          const existing = (yield* goal.get(parentID))?.requirements ?? []
          const revision = params.revised_because?.trim()
          if (existing.length && !revision) {
            return {
              title: "Checklist already recorded",
              output: [
                "This goal already has a checklist and it was not replaced. Review against it as-is.",
                "Replacing it is reserved for a checklist that clearly misinterprets the objective — call again with revised_because stating the misreading.",
                ...existing.map((item) => `${item.id} ${item.text}`),
              ].join("\n"),
              metadata: { existing: existing.length },
            }
          }

          const items = params.requirements
            .map((item) => ({ id: item.id.trim(), text: item.text.trim() }))
            .filter((item) => item.id && item.text)
          if (!items.length) {
            return {
              title: "Checklist empty",
              output:
                "The checklist must contain at least one requirement with a non-empty id and text. Call goal_checklist again.",
              metadata: {},
            }
          }
          const bad = items.filter((item) => !ID_PATTERN.test(item.id))
          if (bad.length) {
            return {
              title: "Checklist ids invalid",
              output: `Requirement ids must be R1, R2, R3, ... in objective order. Invalid: ${bad
                .map((item) => item.id)
                .join(", ")}. Call goal_checklist again.`,
              metadata: {},
            }
          }
          const seen = new Set<string>()
          const duplicates = items.filter((item) => (seen.has(item.id) ? true : (seen.add(item.id), false)))
          if (duplicates.length) {
            return {
              title: "Checklist ids duplicated",
              output: `Requirement ids must be unique. Duplicated: ${[...new Set(duplicates.map((item) => item.id))].join(", ")}. Call goal_checklist again.`,
              metadata: {},
            }
          }

          if (existing.length && revision) {
            yield* Effect.logWarning("goal checklist revised by a later reviewer", {
              "session.id": parentID,
              reviewer: ctx.sessionID,
              reason: revision,
              before: existing.length,
              after: items.length,
            })
          }
          const updated = yield* goal.recordRequirements({
            sessionID: parentID,
            reviewerSessionID: ctx.sessionID,
            requirements: items,
            revise: Boolean(existing.length && revision),
          })
          if (!updated?.requirements?.length) {
            return {
              title: "Checklist not recorded",
              output: "No running review names this session as its reviewer; the checklist was ignored. Do not retry.",
              metadata: {},
            }
          }
          return {
            title: `Checklist recorded: ${updated.requirements.length} requirement(s)`,
            output: [
              "Checklist recorded. Verify each requirement against authoritative current state, then report per-requirement results in goal_verdict:",
              ...updated.requirements.map((item) => `${item.id} ${item.text}`),
            ].join("\n"),
            metadata: { recorded: updated.requirements.length },
          }
        }),
    } satisfies DefWithoutID<typeof Parameters, Metadata>
  }),
)
