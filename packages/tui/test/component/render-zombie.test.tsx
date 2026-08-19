/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { batch, createSignal, onCleanup, Show } from "solid-js"

// The field bug ("input black hole"): a handler throwing DURING a Solid batch
// makes Solid discard the pending-effects queue and leave those effects STALE
// forever — sibling subtrees stop rendering even though their signals keep
// updating. The recovery is a keyed epoch rebuild of the subtree. This test
// drives the WHOLE chain: real throw in an unmount batch → sibling rendering
// verified dead → epoch bump → rendering verified alive again.
test("a throw during an unmount batch zombifies sibling rendering; the epoch rebuild revives it", async () => {
  const [count, setCount] = createSignal(0)
  const [bomb, setBomb] = createSignal(true)
  const [epoch, setEpoch] = createSignal(1)

  function Bomb() {
    onCleanup(() => {
      throw new Error("boom during unmount batch")
    })
    return <text>bomb</text>
  }

  function Harness() {
    return (
      <Show when={epoch()} keyed>
        <box>
          <text>count:{count()}</text>
          <Show when={bomb()}>
            <Bomb />
          </Show>
        </box>
      </Show>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("count:0")

    // Reproduce the zombie: unmount Bomb (whose cleanup throws) in the same
    // batch as a sibling signal write — mirrors a permission toggle landing in
    // the same event batch as a message update.
    let threw = false
    try {
      batch(() => {
        setCount(1)
        setBomb(false)
      })
    } catch {
      threw = true
    }
    await app.renderOnce()

    // Prove the graph is actually dead, not just this frame stale: a FRESH
    // write after the throw must fail to render. If this assertion ever fails
    // the render layer no longer zombifies and the recovery machinery can be
    // retired.
    setCount(2)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(threw).toBe(true)
    expect(frame).not.toContain("count:2")

    // Recovery: the keyed epoch rebuild (what createRenderRecovery triggers on
    // a dispatchErrors increment) must rebuild a live graph that renders both
    // the missed state and future writes.
    setEpoch(2)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("count:2")
    setCount(3)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("count:3")
  } finally {
    app.renderer.destroy()
  }
})
