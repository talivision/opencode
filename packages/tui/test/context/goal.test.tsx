/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import type { SessionGoal } from "@opencode-ai/sdk/v2"
import { GoalProvider, parseGoalCommand, useGoal } from "../../src/context/goal"
import { SDKProvider } from "../../src/context/sdk"
import { eventSource, json } from "../fixture/tui-sdk"

const active: SessionGoal = {
  sessionID: "ses_goal_native",
  objective: "verify the native full TUI",
  status: "active",
  tokensUsed: 0,
  turns: 0,
  time: {
    created: 1,
    updated: 1,
    running: 1,
    elapsed: 0,
  },
}

test("recognizes only the native /goal command boundary", () => {
  expect(parseGoalCommand("/goal")).toBe("")
  expect(parseGoalCommand("/goal --tokens 500 verify everything")).toBe("--tokens 500 verify everything")
  expect(parseGoalCommand("/goalkeeper")).toBeUndefined()
  expect(parseGoalCommand("please /goal test")).toBeUndefined()
})

test("executes /goal through the native goal endpoint", async () => {
  const requests: Array<{ method: string; path: string; body: string }> = []
  const fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input)
    const url = new URL(request.url)
    const body = request.body ? await request.text() : ""
    requests.push({ method: request.method, path: url.pathname, body })
    if (url.pathname === "/session/ses_goal_native/goal" && request.method === "PUT") return json(active)
    throw new Error(`unexpected request: ${request.method} ${url.pathname}`)
  }) as typeof globalThis.fetch

  let resolve!: () => void
  const done = new Promise<void>((next) => {
    resolve = next
  })

  function Probe() {
    const goals = useGoal()
    const [status, setStatus] = createSignal("waiting")
    onMount(() => {
      void goals.execute("ses_goal_native", "verify the native full TUI").then((result) => {
        setStatus(`${result.goal?.status}:${result.start}`)
        resolve()
      })
    })
    return <text>{status()}</text>
  }

  const app = await testRender(() => (
    <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
      <GoalProvider>
        <Probe />
      </GoalProvider>
    </SDKProvider>
  ))

  try {
    await done
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("active:true")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("PUT")
    expect(requests[0]?.path).toBe("/session/ses_goal_native/goal")
    expect(requests[0]?.body).toContain("verify the native full TUI")
    expect(requests.some((request) => request.path.includes("/command"))).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})
