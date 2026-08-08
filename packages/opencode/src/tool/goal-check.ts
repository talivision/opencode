import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Fiber, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Tool } from "./tool"
import { Truncate } from "./truncate"

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({
    description: "One complete operator-approved command, copied exactly from the allowed command list",
  }),
})

type Metadata = {
  exit?: number | null
  timedOut?: boolean
  aborted?: boolean
  refused?: boolean
  allowed?: string[]
  truncated?: boolean
  outputPath?: string
}

// Reviewer checks must always terminate even if an operator-approved command hangs.
const DEFAULT_TIMEOUT_MS = 120_000

export const GoalCheckTool = Tool.define<
  typeof Parameters,
  Metadata,
  Config.Service | ChildProcessSpawner | Truncate.Service
>(
  "goal_check",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const truncate = yield* Truncate.Service

    return {
      description: "Run one operator-approved verification command without a shell.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const allowed = [
            ...new Set((yield* config.get()).goal?.review?.commands?.map((command) => command.trim()) ?? []),
          ].filter((command) => command.length > 0)
          const command = params.command.trim()
          const matched = allowed.find((item) => item === command)
          if (!matched) {
            return {
              title: "Command refused",
              output: [
                "Command refused: it does not exactly match an operator-approved command.",
                "Allowed commands:",
                ...(allowed.length ? allowed.map((item) => `- ${item}`) : ["(none configured)"]),
              ].join("\n"),
              metadata: { refused: true, allowed },
            }
          }

          const instance = yield* InstanceState.context
          const argv = matched.split(/\s+/)
          let output = ""
          let timedOut = false
          let aborted = false
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(argv[0]!, argv.slice(1), {
                  cwd: instance.directory,
                  extendEnv: true,
                  stdin: "ignore",
                  forceKillAfter: "3 seconds",
                }),
              )
              const collector = yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.sync(() => {
                  output += chunk
                }),
              ).pipe(Effect.forkScoped)
              const abort = Effect.callback<void>((resume) => {
                if (ctx.abort.aborted) return resume(Effect.void)
                const handler = () => resume(Effect.void)
                ctx.abort.addEventListener("abort", handler, { once: true })
                return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
              })
              const result = yield* Effect.raceAll([
                handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
                Effect.sleep(DEFAULT_TIMEOUT_MS).pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
                abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
              ])

              if (result.kind === "timeout") timedOut = true
              if (result.kind === "abort") aborted = true
              if (result.kind !== "exit") yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
              yield* Fiber.join(collector).pipe(Effect.catch(() => Effect.void))
              return result.code
            }),
          ).pipe(Effect.orDie)
          const captured = yield* truncate.output(output || "(no output)")

          return {
            title: matched,
            output: [
              `Exit code: ${exit === null ? "unavailable" : exit}`,
              ...(timedOut ? [`Timed out after ${DEFAULT_TIMEOUT_MS} ms.`] : []),
              ...(aborted ? ["Command aborted."] : []),
              "",
              captured.content,
            ].join("\n"),
            metadata: {
              exit,
              timedOut,
              aborted,
              truncated: captured.truncated,
              ...(captured.truncated ? { outputPath: captured.outputPath } : {}),
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
