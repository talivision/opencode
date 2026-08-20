import type { Accessor, Setter } from "solid-js"
import { recordFlight } from "./flight-recorder"
import { graphErrorCount } from "./zombie-guard"

const tickInterval = 2_000
const remountInterval = 30_000
const heartbeatTicks = 15

let remountTotal = 0
let probeSent = 0
let probeEchoed = 0

type TimerHandle = ReturnType<typeof setInterval>

export type WatchdogOptions = {
  log?: string
  remount: () => void | Promise<void>
  now?: () => number
  interval?: (callback: () => void, milliseconds: number) => TimerHandle
  clearInterval?: (timer: TimerHandle) => void
  memoryUsage?: () => Pick<NodeJS.MemoryUsage, "rss" | "heapUsed">
}

export function remountCount() {
  return remountTotal
}

export function createWatchdog(options: WatchdogOptions) {
  probeSent = 0
  probeEchoed = 0
  const now = options.now ?? Date.now
  const interval = options.interval ?? setInterval
  const clear = options.clearInterval ?? clearInterval
  const memoryUsage = options.memoryUsage ?? process.memoryUsage
  let timer: TimerHandle | undefined
  let setProbe: Setter<number> | undefined
  let dispatchErrors: Accessor<number> = () => 0
  let streamErrors: Accessor<number> = () => 0
  let missedProbes = 0
  let tick = 0
  let lastRemount = Number.NEGATIVE_INFINITY
  let consecutiveRemounts = 0
  let probing = false
  let stoppedRemounting = false
  let loggedIneffective = false

  const heartbeat = () => {
    const memory = memoryUsage()
    recordFlight(options.log, "heartbeat", {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      dispatchErrors: dispatchErrors(),
      streamErrors: streamErrors(),
      graphErrors: graphErrorCount(),
      remounts: remountTotal,
      probeSent,
      probeEchoed,
    })
  }

  const check = () => {
    tick += 1
    if (probing && probeEchoed !== probeSent) missedProbes += 1
    if (probing && probeEchoed === probeSent) {
      missedProbes = 0
      consecutiveRemounts = 0
    }

    if (missedProbes >= 2 && consecutiveRemounts >= 2 && !loggedIneffective) {
      stoppedRemounting = true
      loggedIneffective = true
      recordFlight(options.log, "remount ineffective — render loop presumed blocked", {
        remounts: remountTotal,
        missedProbes,
      })
    }

    if (missedProbes >= 2 && !stoppedRemounting && now() - lastRemount >= remountInterval) {
      const missed = missedProbes
      const remounts = remountTotal + 1
      lastRemount = now()
      consecutiveRemounts += 1
      missedProbes = 0
      remountTotal = remounts
      Promise.resolve(options.remount()).then(
        () =>
          recordFlight(options.log, "render graph dead — remounted app", {
            remounts,
            missedProbes: missed,
            graphErrors: graphErrorCount(),
            dispatchErrors: dispatchErrors(),
          }),
        (error) =>
          recordFlight(options.log, "render graph remount failed", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }),
      )
    }

    probeSent += 1
    setProbe?.(probeSent)
    probing = true
    if (tick % heartbeatTicks === 0) heartbeat()
  }

  const run = () => {
    try {
      check()
    } catch (error) {
      recordFlight(options.log, "render graph watchdog failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  return {
    start() {
      if (timer) return
      timer = interval(run, tickInterval)
      if (typeof timer === "object" && timer && "unref" in timer) timer.unref()
    },
    stop() {
      if (!timer) return
      clear(timer)
      timer = undefined
    },
    connectProbe(setter: Setter<number>) {
      setProbe = setter
      missedProbes = 0
      probing = false
    },
    echo(value: number) {
      probeEchoed = value
    },
    connectCounters(counters: { dispatchErrors: Accessor<number>; streamErrors: Accessor<number> }) {
      dispatchErrors = counters.dispatchErrors
      streamErrors = counters.streamErrors
    },
    snapshot() {
      return { probeSent, probeEchoed, missedProbes, stoppedRemounting, consecutiveRemounts }
    },
  }
}

export type Watchdog = ReturnType<typeof createWatchdog>
