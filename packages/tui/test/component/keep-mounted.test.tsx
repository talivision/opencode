/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import { KeepMounted } from "../../src/component/keep-mounted"

test("keeps the composer mounted while transient permission visibility changes", async () => {
  let setVisible!: (value: boolean) => void
  let mounts = 0
  let cleanups = 0

  function ComposerProbe() {
    onMount(() => {
      mounts += 1
      onCleanup(() => {
        cleanups += 1
      })
    })
    return <text>composer</text>
  }

  function Harness() {
    const [visible, updateVisible] = createSignal(true)
    setVisible = updateVisible
    return (
      <KeepMounted visible={visible()}>
        <ComposerProbe />
      </KeepMounted>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(mounts).toBe(1)
    setVisible(false)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("composer")
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)

    setVisible(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("composer")
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
