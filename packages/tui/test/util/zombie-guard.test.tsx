import { expect, test } from "bun:test"
import { batch, createEffect, createRoot, createSignal, onError } from "solid-js"
import { graphErrorCount, noteGraphError } from "../../src/util/zombie-guard"

function runEffectThrow(handled: boolean) {
  let write!: (value: number) => void
  let sibling = -1
  const dispose = createRoot((dispose) => {
    if (handled) onError((error) => noteGraphError(undefined, error))
    const [value, setValue] = createSignal(0)
    write = setValue
    createEffect(() => {
      if (value() === 1) throw new Error("effect exploded")
    })
    createEffect(() => {
      sibling = value()
    })
    return dispose
  })
  return { dispose, write, sibling: () => sibling }
}

test("root onError preserves Solid's pending effect queue", () => {
  const unhandled = runEffectThrow(false)
  try {
    expect(() => batch(() => unhandled.write(1))).toThrow("effect exploded")
    unhandled.write(2)
    expect(unhandled.sibling()).toBe(0)
  } finally {
    unhandled.dispose()
  }

  const before = graphErrorCount()
  const handled = runEffectThrow(true)
  try {
    expect(() => batch(() => handled.write(1))).not.toThrow()
    expect(handled.sibling()).toBe(1)
    handled.write(2)
    expect(handled.sibling()).toBe(2)
    expect(graphErrorCount()).toBe(before + 1)
  } finally {
    handled.dispose()
  }
})
