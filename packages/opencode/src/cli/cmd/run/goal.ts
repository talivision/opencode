import type { OpencodeClient, SessionGoal } from "@opencode-ai/sdk/v2"
import type { FooterApi, RunCommand, RunPrompt, StreamCommit } from "./types"

export const GOAL_COMMAND = {
  name: "goal",
  description: "set or view the goal for a long-running task",
  source: "command",
  template: "",
  hints: ["objective"],
} satisfies RunCommand

export const GOAL_CONTINUATION: RunPrompt = {
  text: "Continue pursuing the active goal.",
  parts: [],
  hidden: true,
}

type Input = {
  sdk: OpencodeClient
  footer: FooterApi
  sessionID: () => string
}

type Result = {
  handled: boolean
  start?: boolean
}

function duration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function count(value: number) {
  return new Intl.NumberFormat("en-US").format(value)
}

function label(goal?: SessionGoal | null) {
  if (!goal) return ""
  const suffix = goal.status === "paused" && goal.pauseReason === "budget" ? " (token budget reached)" : ""
  return `Goal ${goal.status}${suffix} · ${duration(goal.time.elapsed)}`
}

function commands(goal: SessionGoal) {
  if (goal.status === "active") return "/goal edit · /goal pause · /goal clear"
  if (goal.status === "paused" || goal.status === "blocked") return "/goal edit · /goal resume · /goal clear"
  return "/goal edit · /goal clear"
}

export function formatGoal(goal?: SessionGoal | null) {
  if (!goal) {
    return ["Goal", "No goal set", "/goal <objective> to set one"].join("\n")
  }

  const rows = [
    "Goal",
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Time used: ${duration(goal.time.elapsed)}`,
    `Tokens used: ${count(goal.tokensUsed)}`,
    `Turns: ${count(goal.turns)}`,
  ]
  if (goal.tokenBudget !== undefined) rows.push(`Token budget: ${count(goal.tokenBudget)}`)
  if (goal.blocker) rows.push(`Blocker (${goal.blocker.count}/3): ${goal.blocker.reason}`)
  if (goal.pauseReason === "budget") rows.push("Paused because the token budget was reached.")
  rows.push(`Commands: ${commands(goal)}`)
  return rows.join("\n")
}

function commit(text: string): StreamCommit {
  return {
    kind: "system",
    text,
    phase: "final",
    source: "system",
  }
}

function parseBudget(input: string) {
  const tokens = input.trim().split(/\s+/)
  let budget: number | undefined
  const objective: string[] = []

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const inline = token.match(/^--tokens=(\d+)$/)
    if (inline) {
      budget = Number(inline[1])
      continue
    }
    if (token === "--tokens") {
      const value = tokens[index + 1]
      if (!value || !/^\d+$/.test(value)) throw new Error("Usage: /goal [--tokens <positive number>] <objective>")
      budget = Number(value)
      index += 1
      continue
    }
    objective.push(token)
  }

  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) {
    throw new Error("Goal token budget must be a positive integer.")
  }
  return { objective: objective.join(" ").trim(), tokenBudget: budget }
}

export function createGoalController(input: Input) {
  let current: SessionGoal | null | undefined

  const patch = (goal?: SessionGoal | null) => {
    current = goal
    input.footer.event({
      type: "stream.patch",
      patch: { goal: label(goal) },
    })
  }

  const get = async () => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    const response = await input.sdk.session.goal.get({ sessionID }, { throwOnError: true })
    const goal = response.data as SessionGoal | null
    patch(goal)
    return goal
  }

  const show = (goal?: SessionGoal | null) => {
    input.footer.append(commit(formatGoal(goal)))
  }

  const execute = async (prompt: RunPrompt): Promise<Result> => {
    if (prompt.command?.name !== "goal") return { handled: false }
    const sessionID = input.sessionID()
    if (!sessionID) throw new Error("A session is required before setting a goal.")
    const args = prompt.command.arguments.trim()
    const [head = "", ...tail] = args.split(/\s+/)
    const action = head.toLowerCase()

    if (!args) {
      show(await get())
      return { handled: true }
    }

    if (action === "clear") {
      await input.sdk.session.goal.clear({ sessionID }, { throwOnError: true })
      patch(undefined)
      input.footer.append(commit("Goal cleared\nTranscript history was preserved."))
      return { handled: true }
    }

    if (action === "pause") {
      const response = await input.sdk.session.goal.action(
        { sessionID, body: { action: "pause" } },
        { throwOnError: true },
      )
      const goal = response.data
      patch(goal)
      show(goal)
      return { handled: true }
    }

    if (action === "resume") {
      const response = await input.sdk.session.goal.action(
        { sessionID, body: { action: "resume" } },
        { throwOnError: true },
      )
      const goal = response.data
      patch(goal)
      show(goal)
      return { handled: true, start: goal?.status === "active" }
    }

    if (action === "edit") {
      const raw = tail.join(" ").trim()
      if (!raw) {
        const goal = current ?? (await get())
        if (!goal) {
          show(goal)
          return { handled: true }
        }
        input.footer.event({
          type: "prompt.replace",
          prompt: {
            text: `/goal edit ${goal.objective}`,
            parts: [],
            command: { name: "goal", arguments: `edit ${goal.objective}` },
          },
        })
        input.footer.append(commit("Edit goal\nUpdate the objective in the composer and press enter."))
        return { handled: true }
      }
      const next = parseBudget(raw)
      if (!next.objective) throw new Error("Usage: /goal edit [--tokens <positive number>] <objective>")
      const response = await input.sdk.session.goal.action(
        {
          sessionID,
          body: {
            action: "edit",
            objective: next.objective,
            ...(next.tokenBudget === undefined ? {} : { tokenBudget: next.tokenBudget }),
          },
        },
        { throwOnError: true },
      )
      const goal = response.data
      patch(goal)
      show(goal)
      return { handled: true, start: goal?.status === "active" }
    }

    const next = parseBudget(args)
    if (next.objective.split(/\s+/).length < 2) {
      throw new Error("Usage: /goal [--tokens <positive number>] <objective with multiple words>")
    }
    const response = await input.sdk.session.goal.set(
      {
        sessionID,
        objective: next.objective,
        ...(next.tokenBudget === undefined ? {} : { tokenBudget: next.tokenBudget }),
      },
      { throwOnError: true },
    )
    const goal = response.data
    patch(goal)
    show(goal)
    return { handled: true, start: true }
  }

  const refresh = async (announce = false) => {
    const previous = current?.status
    const goal = await get()
    if (announce && goal && goal.status !== previous && goal.status !== "active") show(goal)
    return goal
  }

  return {
    execute,
    refresh,
    reset: () => patch(undefined),
  }
}
