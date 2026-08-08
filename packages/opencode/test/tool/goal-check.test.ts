import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { GoalCheckTool } from "@/tool/goal-check"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const layer = (commands?: string[]) =>
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node, Config.node]), [
    [
      Config.node,
      TestConfig.layer({
        get: () => Effect.succeed(commands ? { goal: { review: { commands } } } : {}),
      }),
    ],
  ])

const context = {
  sessionID: SessionID.make("ses_goal_check"),
  messageID: MessageID.make("msg_goal_check"),
  agent: "goal-reviewer",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const run = Effect.fn("GoalCheckTest.run")(function* (command: string) {
  const info = yield* GoalCheckTool
  const tool = yield* info.init()
  return yield* tool.execute({ command }, context)
})

describe("tool.goal_check", () => {
  const exact = "bun -e console.log(process.cwd()),console.error('goal-stderr'),process.exit(7)"
  const configured = testEffect(layer([exact]))

  configured.instance("runs an exact configured command in the instance directory", () =>
    Effect.gen(function* () {
      const result = yield* run(exact)
      const instance = yield* InstanceState.context

      expect(result.metadata.exit).toBe(7)
      expect(result.output).toContain("Exit code: 7")
      expect(result.output).toContain(instance.directory)
      expect(result.output).toContain("goal-stderr")
    }),
  )

  configured.instance("refuses a command that is not configured and names the allowed commands", () =>
    Effect.gen(function* () {
      const result = yield* run("bun test test/other/")

      expect(result.metadata.refused).toBe(true)
      expect(result.output).toContain("Command refused")
      expect(result.output).toContain(exact)
    }),
  )

  const marker = "bun -e require('fs').writeFileSync('goal-check-ran','yes')"
  const nearMiss = testEffect(layer([marker]))
  nearMiss.instance("refuses appended arguments, longer prefixes, and shell metacharacters without executing", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const attempts = [`${marker} extra`, `${marker}-suffix`, `${marker}; rm -rf /`]

      for (const attempt of attempts) {
        const result = yield* run(attempt)
        expect(result.metadata.refused).toBe(true)
        expect(result.output).toContain(marker)
      }
      expect(yield* Effect.promise(() => Bun.file(`${instance.directory}/goal-check-ran`).exists())).toBe(false)
    }),
  )

  testEffect(layer()).instance("refuses every command when no commands are configured", () =>
    Effect.gen(function* () {
      const result = yield* run("bun test")

      expect(result.metadata.refused).toBe(true)
      expect(result.output).toContain("(none configured)")
    }),
  )
})
