import { createSignal } from "solid-js"
import { recordFlight } from "./flight-recorder"

let count = 0
const [graphErrors, setGraphErrors] = createSignal(0)

export { graphErrors }

export function graphErrorCount() {
  return count
}

export function noteGraphError(log: string | undefined, error: unknown) {
  try {
    count += 1
    setGraphErrors(count)
    recordFlight(log, "render graph error handled", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  } catch {
    // An error handler must never become a second source of render graph failure.
  }
}
