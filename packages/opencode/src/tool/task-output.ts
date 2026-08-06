import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import { define, type DefWithoutID } from "./tool"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The task session ID" }),
})

type Metadata = {
  taskSessionID: SessionID
  sessionStatus: SessionStatus.Info["type"]
  backgroundStatus?: BackgroundJob.Status
}

export const TaskOutputTool = define<
  typeof Parameters,
  Metadata,
  BackgroundJob.Service | Session.Service | SessionStatus.Service
>(
  "task_output",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service

    return {
      description: "Read a task's status and output-so-far without waiting for it. Non-blocking.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const taskSessionID = SessionID.make(params.task_id)
          const task = yield* sessions.get(taskSessionID)
          yield* requireOwnership(sessions, task, ctx.sessionID)
          const sessionStatus = yield* status.get(taskSessionID)
          const job = yield* background.get(taskSessionID)
          const transcript = renderTranscript(yield* sessions.messages({ sessionID: taskSessionID }))
          const current =
            job?.status ?? (sessionStatus.type === "busy" || sessionStatus.type === "retry" ? "running" : "idle")
          return {
            title: `Task output: ${current}`,
            metadata: {
              taskSessionID,
              sessionStatus: sessionStatus.type,
              ...(job ? { backgroundStatus: job.status } : {}),
            },
            output: [
              `<task-output task_id="${taskSessionID}" status="${current}">`,
              `<session_status>${sessionStatus.type}</session_status>`,
              ...(job ? [`<background_status>${job.status}</background_status>`] : []),
              "<transcript>",
              transcript,
              "</transcript>",
              "</task-output>",
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

function renderTranscript(messages: SessionV1.WithParts[]) {
  const transcript = messages
    .flatMap((message) => {
      const role = message.info.role === "assistant" ? "ASSISTANT" : "USER"
      const parts = message.parts.flatMap((part) => {
        if (part.type === "text") return [part.text]
        if (part.type !== "tool") return []
        const state = part.state
        const result =
          state.status === "completed"
            ? state.output
            : state.status === "error"
              ? state.error
              : state.status === "running"
                ? state.title
                : state.status
        return [`[tool ${part.tool} ${state.status}] input=${JSON.stringify(state.input)} result=${result}`]
      })
      if (!parts.length) return []
      return [`${role}:\n${parts.join("\n")}`]
    })
    .join("\n\n")
  const limit = 10 * 1024
  if (transcript.length <= limit) return transcript
  return `[Earlier transcript omitted for length]\n${transcript.slice(-limit)}`
}
