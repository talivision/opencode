import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
const directories = new Map<string, Promise<void>>()

export function recordFlight(log: string | undefined, message: string, fields: Record<string, unknown> = {}) {
  if (!log) return
  const ready = directories.get(log) ?? mkdir(log, { recursive: true }).then(() => undefined)
  directories.set(log, ready)
  const values = {
    timestamp: new Date().toISOString(),
    level: "INFO",
    run: "tui",
    message,
    ...fields,
  }
  const line =
    Object.entries(values)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ") + "\n"
  void ready.then(() => appendFile(path.join(log, "opencode.log"), line)).catch(() => {})
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : JSON.stringify(input)
  return value !== undefined && /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}
