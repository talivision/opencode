import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createRenderRecovery } from "../../src/util/render-recovery"

test("automatic recovery throttles bursts and keeps desync pending until the trailing rebuild", () => {
  let time = 0
  let increment!: () => void
  let trailing!: () => void
  let recovery!: ReturnType<typeof createRenderRecovery>
  const timer = {} as ReturnType<typeof setTimeout>
  const dispose = createRoot((dispose) => {
    const [errors, setErrors] = createSignal(0)
    increment = () => setErrors((value) => value + 1)
    recovery = createRenderRecovery(errors, {
      now: () => time,
      timeout(callback) {
        trailing = callback
        return timer
      },
      clearTimeout() {},
    })
    return dispose
  })

  try {
    increment()
    expect(recovery.renderEpoch()).toBe(2)
    recovery.resolve(2)
    expect(recovery.desynced()).toBe(false)

    time = 100
    increment()
    increment()
    expect(recovery.renderEpoch()).toBe(2)
    expect(recovery.desynced()).toBe(true)
    recovery.resolve(2)
    expect(recovery.desynced()).toBe(true)

    time = 2_000
    trailing()
    expect(recovery.renderEpoch()).toBe(3)
    expect(recovery.desynced()).toBe(true)
    recovery.resolve(3)
    expect(recovery.desynced()).toBe(false)
  } finally {
    dispose()
  }
})
