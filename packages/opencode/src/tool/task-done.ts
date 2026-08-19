import { Session } from "@/session/session"
import { Effect, Schema } from "effect"
import { define, type DefWithoutID } from "./tool"

// Postel's law: this tool must be effectively unfailable. Real models pass
// numbers, objects, or nothing; a schema REJECTION here detours through the
// SDK's repair path and has produced provider-speed retry spirals (observed
// at ~19 requests/second). Accept anything and coerce it to a string — a
// wrong-shaped summary is still a summary.
export function coerceSummary(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (value === null || value === undefined) return ""
  if (typeof value === "object") {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value).trim()
}

export const Parameters = Schema.Struct({
  summary: Schema.optional(Schema.Unknown).annotate({
    description: "A concise summary of the completed task outcome, or why the task could not be completed",
  }),
})

export const TaskDoneTool = define<typeof Parameters, {}, Session.Service>(
  "task_done",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description:
        "Mark a subagent task as finished. Call this as your final tool call after completing the task, or after determining that it cannot be completed.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const self = yield* sessions.get(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          if (!self?.parentID) {
            return {
              title: "No parent task",
              output: "This is a top-level session, so there is no parent task whose completion can be recorded.",
              metadata: {},
            }
          }
          if (!coerceSummary(params.summary)) {
            return {
              title: "Summary missing",
              output: "The summary must not be empty. Call task_done again with a non-empty summary.",
              metadata: {},
            }
          }
          return {
            title: "Completion recorded",
            output: "Completion recorded. This task is now finished.",
            metadata: {},
          }
        }),
    } satisfies DefWithoutID<typeof Parameters, {}>
  }),
)
