/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { createRenderRecovery } from "../../src/util/render-recovery"

test("dispatch errors expose recovery status and advance the render epoch", async () => {
  let increment!: () => void
  let recovery!: ReturnType<typeof createRenderRecovery>

  function Harness() {
    const [errors, setErrors] = createSignal(0)
    increment = () => setErrors((value) => value + 1)
    recovery = createRenderRecovery(errors)
    return (
      <box>
        <text>epoch:{recovery.renderEpoch()}</text>
        <Show when={recovery.desynced()}>
          <text>Display desynced</text>
        </Show>
      </box>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(recovery.renderEpoch()).toBe(1)
    expect(recovery.desynced()).toBe(false)

    increment()
    await app.renderOnce()
    expect(recovery.renderEpoch()).toBe(2)
    expect(recovery.desynced()).toBe(true)
    expect(app.captureCharFrame()).toContain("Display desynced")

    recovery.resolve(2)
    await app.renderOnce()
    expect(recovery.desynced()).toBe(false)
    expect(app.captureCharFrame()).not.toContain("Display desynced")
  } finally {
    app.renderer.destroy()
  }
})
