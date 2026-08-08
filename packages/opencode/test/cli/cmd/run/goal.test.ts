import { describe, expect, mock, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { createGoalController } from "@/cli/cmd/run/goal"
import type { FooterApi, RunPrompt } from "@/cli/cmd/run/types"

const usage = "Usage: /goal [--tokens <positive number>] <objective with multiple words>"

function setup() {
  const set = mock(async () => ({ data: null }))
  const sdk = {
    session: {
      goal: { set },
    },
  } as unknown as OpencodeClient
  const footer = {
    event: mock(() => {}),
    append: mock(() => {}),
  } as unknown as FooterApi
  const controller = createGoalController({ sdk, footer, sessionID: () => "session-1" })

  return { controller, set }
}

function prompt(arguments_: string): RunPrompt {
  return {
    text: "",
    parts: [],
    command: { name: "goal", arguments: arguments_ },
  }
}

describe("run goal controller", () => {
  test("rejects a single-word objective without setting a goal", async () => {
    const { controller, set } = setup()

    await expect(controller.execute(prompt("x"))).rejects.toThrow(usage)
    expect(set).not.toHaveBeenCalled()
  })

  test("rejects a single-word objective after parsing a token budget", async () => {
    const { controller, set } = setup()

    await expect(controller.execute(prompt("--tokens 500 x"))).rejects.toThrow(usage)
    expect(set).not.toHaveBeenCalled()
  })

  test("sets a multi-word objective", async () => {
    const { controller, set } = setup()

    await controller.execute(prompt("fix the bug"))

    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(
      {
        sessionID: "session-1",
        objective: "fix the bug",
      },
      { throwOnError: true },
    )
  })
})
