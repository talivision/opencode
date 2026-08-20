import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { graphErrors, noteGraphError } from "../../src/util/zombie-guard"

// Pins the test environment's solid-js resolution to production semantics:
// solid's server dist never re-runs effects (its exports map serves it under
// the plain node condition), so a test suite that silently resolved it would
// pass render tests vacuously. This asserts (1) effects re-run on writes at
// all — client/universal semantics — and (2) the test file and the src tree
// share ONE solid instance: an effect created with the test's import must
// re-run when a signal owned by a src module changes. Two mixed instances
// would each have their own reactive runtime and never see each other.
test("test-env solid-js is one reactive client instance shared with src modules", () => {
  const seen: number[] = []
  const dispose = createRoot((dispose) => {
    createEffect(() => seen.push(graphErrors()))
    return dispose
  })
  try {
    const before = seen.length
    expect(before).toBeGreaterThan(0)
    noteGraphError(undefined, new Error("resolution probe"))
    expect(seen.length).toBe(before + 1)
    expect(seen[seen.length - 1]).toBe(seen[before - 1] + 1)
  } finally {
    dispose()
  }
})
