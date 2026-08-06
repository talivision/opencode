import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Effect, Schema } from "effect"
import { type TaskPromptOps } from "./task"
import { define, type DefWithoutID } from "./tool"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The task session ID" }),
})

type Metadata = {
  taskSessionID: SessionID
  sessionStatus: SessionStatus.Info["type"]
  backgroundStatus?: BackgroundJob.Status
}

export const TaskStopTool = define<
  typeof Parameters,
  Metadata,
  BackgroundJob.Service | Session.Service | SessionStatus.Service
>(
  "task_stop",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service

    return {
      description: "Stop a running task. The task's session is preserved and can be resumed with task(task_id=...).",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const taskSessionID = SessionID.make(params.task_id)
          const task = yield* sessions.get(taskSessionID)
          yield* requireOwnership(sessions, task, ctx.sessionID)
          const ops = ctx.extra?.promptOps as TaskPromptOps
          if (!ops) return yield* Effect.fail(new Error("TaskStopTool requires promptOps in ctx.extra"))
          const job = yield* background.get(taskSessionID)
          const stopped = yield* Effect.all(
            {
              background: job ? background.cancel(taskSessionID) : Effect.succeed(undefined),
              session: ops.cancel(taskSessionID),
            },
            { concurrency: "unbounded" },
          )
          const sessionStatus = yield* status.get(taskSessionID)
          const backgroundStatus = stopped.background?.status ?? job?.status
          return {
            title: "Task stopped",
            metadata: {
              taskSessionID,
              sessionStatus: sessionStatus.type,
              ...(backgroundStatus ? { backgroundStatus } : {}),
            },
            output: [
              `<task-stop task_id="${taskSessionID}" status="stopped">`,
              `<session_status>${sessionStatus.type}</session_status>`,
              ...(backgroundStatus ? [`<background_status>${backgroundStatus}</background_status>`] : []),
              "</task-stop>",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    } satisfies DefWithoutID<typeof Parameters, Metadata>
  }),
)

const requireOwnership = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  task: Session.Info,
  parentID: SessionID,
) {
  let current = task
  while (current.parentID) {
    if (current.parentID === parentID) return
    current = yield* sessions.get(current.parentID)
  }
  return yield* Effect.fail(new Error(`Task ${task.id} is not owned by session ${parentID}`))
})
