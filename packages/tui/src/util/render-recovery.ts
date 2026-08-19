import { createEffect, createSignal, on, type Accessor } from "solid-js"

export function createRenderRecovery(dispatchErrors: Accessor<number>) {
  const [renderEpoch, setRenderEpoch] = createSignal(1)
  const [pending, setPending] = createSignal(dispatchErrors())
  let seen = dispatchErrors()

  createEffect(
    on(dispatchErrors, (value) => {
      if (value <= seen) return
      seen = value
      setPending(value)
      setRenderEpoch((epoch) => epoch + 1)
    }),
  )

  return {
    renderEpoch,
    desynced: () => pending() > 0,
    recover() {
      setPending(Math.max(dispatchErrors(), 1))
      setRenderEpoch((epoch) => epoch + 1)
    },
    resolve(epoch: number) {
      if (epoch !== renderEpoch()) return
      setPending(0)
    },
  }
}
