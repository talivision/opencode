import { Session } from "@/session/session"
import { Effect, Schema } from "effect"
import { define, type DefWithoutID } from "./tool"

export const Parameters = Schema.Struct({
  summary: Schema.String.annotate({
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
          if (!params.summary.trim()) {
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
