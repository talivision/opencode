import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

type TimerHandle = ReturnType<typeof setTimeout>

export function createRenderRecovery(
  errors: Accessor<number>,
  options: {
    now?: () => number
    timeout?: (callback: () => void, milliseconds: number) => TimerHandle
    clearTimeout?: (timer: TimerHandle) => void
  } = {},
) {
  const now = options.now ?? Date.now
  const timeout = options.timeout ?? setTimeout
  const clear = options.clearTimeout ?? clearTimeout
  const [renderEpoch, setRenderEpoch] = createSignal(1)
  const [pending, setPending] = createSignal(errors())
  let seen = errors()
  let lastRebuild = Number.NEGATIVE_INFINITY
  let queued = false
  let timer: TimerHandle | undefined

  const rebuild = () => {
    queued = false
    lastRebuild = now()
    setRenderEpoch((epoch) => epoch + 1)
  }

  const schedule = () => {
    if (timer) return
    timer = timeout(
      () => {
        timer = undefined
        const remaining = 2_000 - (now() - lastRebuild)
        if (remaining > 0) {
          schedule()
          return
        }
        if (queued) rebuild()
      },
      Math.max(0, 2_000 - (now() - lastRebuild)),
    )
  }

  createEffect(
    on(errors, (value) => {
      if (value <= seen) return
      seen = value
      setPending(value)
      if (now() - lastRebuild >= 2_000) {
        if (timer) clear(timer)
        timer = undefined
        rebuild()
        return
      }
      queued = true
      schedule()
    }),
  )

  onCleanup(() => {
    if (timer) clear(timer)
  })

  return {
    renderEpoch,
    desynced: () => pending() > 0,
    recover() {
      setPending(Math.max(errors(), 1))
      setRenderEpoch((epoch) => epoch + 1)
    },
    resolve(epoch: number) {
      if (epoch !== renderEpoch()) return
      if (queued) return
      setPending(0)
    },
  }
}
