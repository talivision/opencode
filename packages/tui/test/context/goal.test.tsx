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

const completed: SessionGoal = {
  ...active,
  status: "complete",
  turns: 2,
  time: { created: 1, updated: 9, elapsed: 8 },
}

// The cached goal comes from a one-second poll, so when a run ends the TUI can
// still be holding an "active" copy of a goal the run just completed. Resuming
// on that copy is what sent one extra worker turn — a full provider round trip
// against a finished goal — after an accepted review.
test("does not resume a goal that only the cached snapshot still calls active", async () => {
  const requests: string[] = []
  let sent = 0
  const fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input)
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}`)
    if (url.pathname === "/session/ses_goal_native/goal" && request.method === "GET") return json(completed)
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
      void goals
        .resume("ses_goal_native", async () => {
          sent += 1
        })
        .then((goal) => {
          setStatus(`${goal?.status}:${sent}`)
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
    expect(sent).toBe(0)
    expect(app.captureCharFrame()).toContain("complete:0")
    expect(requests).toEqual(["GET /session/ses_goal_native/goal"])
  } finally {
    app.renderer.destroy()
  }
})

test("resumes a goal that authoritative state still reports as active", async () => {
  let sent = 0
  const fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input)
    const url = new URL(request.url)
    if (url.pathname === "/session/ses_goal_native/goal" && request.method === "GET") return json(active)
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
      void goals
        .resume("ses_goal_native", async () => {
          sent += 1
        })
        .then((goal) => {
          setStatus(`${goal?.status}:${sent}`)
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
    expect(sent).toBe(1)
    expect(app.captureCharFrame()).toContain("active:1")
  } finally {
    app.renderer.destroy()
  }
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
