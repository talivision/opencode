/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

test("retries a failed SSE stream and increments reconnects after its replacement is established", async () => {
  let requests = 0
  let sdk!: ReturnType<typeof useSDK>
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/global/event") throw new Error(`unexpected request: ${url.pathname}`)
    requests += 1
    if (requests === 1) {
      return new Response(new ReadableStream({ start: (controller) => controller.error(new Error("stream failed")) }), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
  }) as typeof globalThis.fetch

  function Probe() {
    const context = useSDK()
    onMount(() => {
      sdk = context
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" fetch={fetch}>
        <Probe />
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => requests === 1)
    expect(sdk.reconnects()).toBe(0)
    await wait(() => requests === 2)
    expect(sdk.reconnects()).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
