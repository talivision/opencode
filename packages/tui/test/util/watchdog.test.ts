import { expect, test } from "bun:test"
import { createWatchdog } from "../../src/util/watchdog"

function fakeInterval() {
  let callback = () => {}
  return {
    interval(next: () => void) {
      callback = next
      return {} as ReturnType<typeof setInterval>
    },
    tick() {
      callback()
    },
  }
}

test("two missed echoes remount once and a recovered probe prevents another remount", () => {
  const clock = fakeInterval()
  let calls = 0
  const watchdog = createWatchdog({
    interval: clock.interval,
    clearInterval() {},
    remount() {
      calls += 1
      watchdog.connectProbe((value) => {
        watchdog.echo(typeof value === "function" ? value(0) : value)
        return typeof value === "function" ? value(0) : value
      })
    },
  })
  watchdog.connectProbe((value) => (typeof value === "function" ? value(0) : value))
  watchdog.start()

  clock.tick()
  clock.tick()
  expect(calls).toBe(0)
  clock.tick()
  expect(calls).toBe(1)
  clock.tick()
  clock.tick()
  clock.tick()
  expect(calls).toBe(1)
  expect(watchdog.snapshot().missedProbes).toBe(0)
  watchdog.stop()
})

test("remounts are limited to once per 30 seconds and stop after two ineffective attempts", () => {
  const clock = fakeInterval()
  let time = 0
  let calls = 0
  const watchdog = createWatchdog({
    now: () => time,
    interval: clock.interval,
    clearInterval() {},
    remount() {
      calls += 1
    },
  })
  watchdog.connectProbe((value) => (typeof value === "function" ? value(0) : value))
  watchdog.start()

  clock.tick()
  clock.tick()
  clock.tick()
  expect(calls).toBe(1)

  clock.tick()
  clock.tick()
  time = 29_999
  clock.tick()
  expect(calls).toBe(1)
  time = 30_000
  clock.tick()
  expect(calls).toBe(2)

  clock.tick()
  clock.tick()
  expect(watchdog.snapshot().stoppedRemounting).toBe(true)
  time = 90_000
  clock.tick()
  clock.tick()
  expect(calls).toBe(2)
  watchdog.stop()
})
