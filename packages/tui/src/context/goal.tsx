import type { SessionGoal } from "@opencode-ai/sdk/v2"
import { createContext, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"
import { useSDK } from "./sdk"

type Goal = SessionGoal | null

type CommandResult = {
  goal: Goal
  action: "show" | "changed" | "cleared" | "edit"
  start: boolean
}

type GoalContext = {
  get(sessionID: string): Accessor<Goal | undefined>
  refresh(sessionID: string): Promise<Goal>
  resume(sessionID: string, send: () => Promise<unknown>): Promise<Goal>
  execute(sessionID: string, input: string): Promise<CommandResult>
}

const context = createContext<GoalContext>()

export function GoalProvider(props: ParentProps) {
  const sdk = useSDK()
  const [goals, setGoals] = createSignal(new Map<string, Goal>())

  const patch = (sessionID: string, goal: Goal) => {
    const serialized = JSON.stringify(goal)
    setGoals((current) => {
      if (JSON.stringify(current.get(sessionID)) === serialized) return current
      const next = new Map(current)
      next.set(sessionID, goal)
      return next
    })
    return goal
  }

  const refresh = async (sessionID: string) => {
    const response = await sdk.client.session.goal.get({ sessionID }, { throwOnError: true })
    return patch(sessionID, (response.data as SessionGoal | null) ?? null)
  }

  // The cached goal is whatever the one-second poll last read, so it lags the
  // run it describes. A goal that the run completed, paused or blocked is still
  // "active" in that copy until the next poll lands, and the session reports
  // idle the moment the run ends — so a continuation decided on the cached copy
  // sends one more worker turn at a goal that is already over. Nothing mutates
  // a goal while its session is idle, which makes a re-read here authoritative:
  // decide on that, and hand the caller the state it was decided on.
  const resume = async (sessionID: string, send: () => Promise<unknown>) => {
    const current = await refresh(sessionID)
    if (current?.status !== "active") return current
    await send()
    return current
  }

  const execute = async (sessionID: string, input: string): Promise<CommandResult> => {
    const args = input.trim()
    const [head = "", ...tail] = args.split(/\s+/)
    const action = head.toLowerCase()

    if (!args) return { goal: await refresh(sessionID), action: "show", start: false }

    if (action === "clear") {
      await sdk.client.session.goal.clear({ sessionID }, { throwOnError: true })
      return { goal: patch(sessionID, null), action: "cleared", start: false }
    }

    if (action === "pause" || action === "resume") {
      const response = await sdk.client.session.goal.action({ sessionID, body: { action } }, { throwOnError: true })
      const goal = patch(sessionID, (response.data as SessionGoal | null) ?? null)
      return { goal, action: "changed", start: action === "resume" && goal?.status === "active" }
    }

    if (action === "edit") {
      const raw = tail.join(" ").trim()
      if (!raw) return { goal: await refresh(sessionID), action: "edit", start: false }
      const next = parseBudget(raw)
      if (!next.objective) throw new Error("Usage: /goal edit [--tokens <positive number>] <objective>")
      const response = await sdk.client.session.goal.action(
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
      const goal = patch(sessionID, (response.data as SessionGoal | null) ?? null)
      return { goal, action: "changed", start: goal?.status === "active" }
    }

    if (tail.length === 0) {
      throw new Error("Usage: /goal [--tokens <positive number>] <objective with multiple words>")
    }

    const next = parseBudget(args)
    if (!next.objective) throw new Error("Usage: /goal [--tokens <positive number>] <objective>")
    const current = goals().get(sessionID)
    if (current?.status === "active") {
      throw new Error(
        `An active goal already exists: "${current.objective}". Use /goal edit to replace it with "${next.objective}".`,
      )
    }
    const response = await sdk.client.session.goal.set(
      {
        sessionID,
        objective: next.objective,
        ...(next.tokenBudget === undefined ? {} : { tokenBudget: next.tokenBudget }),
      },
      { throwOnError: true },
    )
    const goal = patch(sessionID, (response.data as SessionGoal | null) ?? null)
    return { goal, action: "changed", start: true }
  }

  return (
    <context.Provider
      value={{
        get: (sessionID) => () => goals().get(sessionID),
        refresh,
        resume,
        execute,
      }}
    >
      {props.children}
    </context.Provider>
  )
}

export function useGoal() {
  const value = useContext(context)
  if (!value) throw new Error("useGoal must be used within GoalProvider")
  return value
}

export function parseGoalCommand(input: string) {
  const first = input.split("\n")[0]?.trim() ?? ""
  if (first !== "/goal" && !first.startsWith("/goal ")) return
  return input.slice(input.indexOf("/goal") + "/goal".length).trim()
}

export function goalDuration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function parseBudget(input: string) {
  const tokens = input.trim().split(/\s+/)
  let tokenBudget: number | undefined
  const objective: string[] = []

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const inline = token.match(/^--tokens=(\d+)$/)
    if (inline) {
      tokenBudget = Number(inline[1])
      continue
    }
    if (token === "--tokens") {
      const value = tokens[index + 1]
      if (!value || !/^\d+$/.test(value)) throw new Error("Usage: /goal [--tokens <positive number>] <objective>")
      tokenBudget = Number(value)
      index += 1
      continue
    }
    objective.push(token)
  }

  if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
    throw new Error("Goal token budget must be a positive integer.")
  }
  return { objective: objective.join(" ").trim(), tokenBudget }
}
