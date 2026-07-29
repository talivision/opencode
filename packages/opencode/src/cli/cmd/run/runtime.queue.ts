// Serial prompt queue for direct interactive mode.
//
// Prompts arrive from the footer (user types and hits enter) and queue up
// here. The queue drains one turn at a time; ordinary prompts waiting behind
// an active ordinary turn are exposed for edit/removal until they begin.
//
// The queue also handles /exit, /quit, and /new commands, empty-prompt rejection,
// and tracks per-turn wall-clock duration for the footer status line.
//
// Resolves when the footer closes and all in-flight work finishes.
import * as Locale from "@/util/locale"
import { MessageID, PartID } from "@/session/schema"
import { isExitCommand, isNewCommand } from "./prompt.shared"
import type { FooterApi, FooterEvent, FooterQueuedPrompt, RunPrompt } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error?: unknown) => void
}

export type QueueInput = {
  footer: FooterApi
  initialInput?: string
  initialPrompt?: RunPrompt
  trace?: Trace
  onSend?: (prompt: RunPrompt) => void
  onNewSession?: () => void | Promise<void>
  isControl?: (prompt: RunPrompt) => boolean
  control?: (prompt: RunPrompt) => Promise<{ handled: boolean; start?: boolean }>
  continuation?: RunPrompt
  run: (prompt: RunPrompt, signal: AbortSignal) => Promise<void>
}

type State = {
  queue: RunPrompt[]
  queued: FooterQueuedPrompt[]
  active?: RunPrompt
  ctrl?: AbortController
  closed: boolean
}

function defer<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

// Runs the prompt queue until the footer closes.
//
// Subscribes to footer prompt events and drains operations through input.run().
// Ordinary prompts submitted during an ordinary active turn remain local and
// are exposed by the footer for edit/removal until their turn begins.
export async function runPromptQueue(input: QueueInput): Promise<void> {
  const stop = defer<{ type: "closed" }>()
  const done = defer()
  const state: State = {
    queue: [],
    queued: [],
    closed: input.footer.isClosed,
  }
  let draining: Promise<void> | undefined
  let controls: Promise<void> = Promise.resolve()

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    input.trace?.write("ui.patch", row)
    input.footer.event(next)
  }

  const syncQueue = () => {
    const queue = state.queue.length
    emit({ type: "queue", queue }, { queue })
    emit(
      {
        type: "queued.prompts",
        prompts: [...state.queued],
      },
      { queued: state.queued.length },
    )
  }

  const removeLocalQueued = (queued: FooterQueuedPrompt) => {
    if (!state.queued.includes(queued)) return
    state.queued = state.queued.filter((item) => item !== queued)
    syncQueue()
  }

  const finish = () => {
    if (!state.closed || draining) {
      return
    }

    done.resolve()
  }

  const close = () => {
    if (state.closed) {
      return
    }

    state.closed = true
    state.queue.length = 0
    state.queued.length = 0
    state.ctrl?.abort()
    stop.resolve({ type: "closed" })
    finish()
  }

  const drain = () => {
    if (draining || state.closed || state.queue.length === 0) {
      return
    }

    draining = (async () => {
      try {
        while (!state.closed && state.queue.length > 0) {
          const prompt = state.queue.shift()
          if (!prompt) {
            continue
          }

          const queued = state.queued.find((item) => item.prompt === prompt)
          if (queued) removeLocalQueued(queued)

          if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
            syncQueue()
            if (!input.onNewSession) {
              emit(
                {
                  type: "stream.patch",
                  patch: {
                    status: "new sessions unavailable",
                  },
                },
                {
                  status: "new sessions unavailable",
                },
              )
              continue
            }

            emit(
              {
                type: "stream.patch",
                patch: {
                  phase: "running",
                  status: "starting new session",
                  queue: state.queue.length,
                },
              },
              {
                phase: "running",
                status: "starting new session",
                queue: state.queue.length,
              },
            )
            await input.onNewSession()
            continue
          }

          const sent =
            prompt.mode === "shell"
              ? prompt
              : {
                  ...prompt,
                  messageID: prompt.messageID ?? queued?.messageID ?? MessageID.ascending(),
                }
          state.active = sent

          emit(
            {
              type: "turn.send",
              queue: state.queue.length,
            },
            {
              phase: "running",
              status: "sending prompt",
              queue: state.queue.length,
            },
          )
          const start = Date.now()
          const ctrl = new AbortController()
          state.ctrl = ctrl

          try {
            await input.footer.idle()
            if (state.closed) {
              break
            }

            if (sent.mode !== "shell" && !sent.hidden) {
              const commit = {
                kind: "user",
                text: sent.text,
                phase: "start",
                source: "system",
                messageID: sent.messageID,
              } as const
              input.trace?.write("ui.commit", commit)
              input.footer.append(commit)
            }
            if (!sent.hidden) input.onSend?.(sent)

            if (state.closed) {
              break
            }

            const task = input.run(sent, ctrl.signal).then(
              () => ({ type: "done" as const }),
              (error) => ({ type: "error" as const, error }),
            )

            const next = await Promise.race([task, stop.promise])
            if (next.type === "closed") {
              ctrl.abort()
              break
            }

            if (next.type === "error") {
              throw next.error
            }
          } finally {
            if (state.ctrl === ctrl) {
              state.ctrl = undefined
            }

            if (sent.mode !== "shell") {
              const duration = Locale.duration(Math.max(0, Date.now() - start))
              emit(
                {
                  type: "turn.duration",
                  duration,
                },
                {
                  duration,
                },
              )
            }
            state.active = undefined
          }
        }
      } catch (error) {
        done.reject(error)
        return
      } finally {
        draining = undefined
        emit(
          {
            type: "turn.idle",
            queue: state.queue.length,
          },
          {
            phase: "idle",
            status: "",
            queue: state.queue.length,
          },
        )
      }

      finish()
    })()
  }

  const runControl = (prompt: RunPrompt) => {
    const wasActive = !!state.active
    const sent = {
      ...prompt,
      messageID: prompt.messageID ?? MessageID.ascending(),
    }
    controls = controls.then(async () => {
      if (state.closed || !input.control) return
      if (!sent.hidden) {
        const commit = {
          kind: "user",
          text: sent.text,
          phase: "start",
          source: "system",
          messageID: sent.messageID,
        } as const
        input.trace?.write("ui.commit", commit)
        input.footer.append(commit)
        input.onSend?.(sent)
      }

      try {
        const result = await input.control(sent)
        if (result.start && !wasActive && input.continuation) submit(input.continuation)
      } catch (error) {
        input.footer.append({
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
          phase: "start",
          source: "system",
          messageID: sent.messageID,
        })
      }
    })
  }

  const submit = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || state.closed) {
      return
    }

    if (prompt.mode !== "shell" && isExitCommand(prompt.text)) {
      input.footer.close()
      return
    }

    if (input.isControl?.(prompt)) {
      emit({ type: "first", first: false }, { first: false })
      runControl(prompt)
      return
    }

    const active = state.active
    if (
      active &&
      active.mode !== "shell" &&
      !active.command &&
      prompt.mode !== "shell" &&
      !prompt.command &&
      !isNewCommand(prompt.text)
    ) {
      const queued: FooterQueuedPrompt = {
        messageID: MessageID.ascending(),
        partID: PartID.ascending(),
        prompt,
      }
      state.queued = [...state.queued, queued]
      state.queue.push(prompt)
      syncQueue()
      return
    }

    state.queue.push(prompt)
    syncQueue()
    if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
      drain()
      return
    }

    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )
    drain()
  }

  const offPrompt = input.footer.onPrompt((prompt) => {
    submit(prompt)
  })
  const offClose = input.footer.onClose(() => {
    close()
  })
  const offRemoveQueued = input.footer.onQueuedRemove((messageID) => {
    const queued = state.queued.find((item) => item.messageID === messageID)
    if (!queued) return false
    state.queue = state.queue.filter((prompt) => prompt !== queued.prompt)
    removeLocalQueued(queued)
    return true
  })

  try {
    if (state.closed) {
      return
    }

    if (input.initialInput) {
      submit({
        text: input.initialInput,
        parts: [],
      })
    } else if (input.initialPrompt) {
      submit(input.initialPrompt)
    }
    finish()
    await done.promise
  } finally {
    offPrompt()
    offClose()
    offRemoveQueued()
    close()
    await draining?.catch(() => {})
    await controls.catch(() => {})
  }
}
