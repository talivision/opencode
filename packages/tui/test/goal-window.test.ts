import { expect, test } from "bun:test"
import { Schema } from "effect"

import { Info } from "../src/config"
import { TuiKeybind } from "../src/config/keybind"

const decodeInfo = Schema.decodeUnknownSync(Info)

test("validates the goal height cap", () => {
  expect(decodeInfo({ goal: { max_height: 4 } })).toEqual({ goal: { max_height: 4 } })
  expect(() => decodeInfo({ goal: { max_height: 0 } })).toThrow()
})

test("defines collision-free goal and subagent navigation defaults", () => {
  expect(TuiKeybind.defaultValue("goal_minimize")).toBe("<leader>z")
  expect(Object.entries(TuiKeybind.Definitions).filter(([, item]) => item.default === "<leader>z")).toHaveLength(1)
  expect(TuiKeybind.CommandMap.goal_minimize).toBe("goal.minimize")
  expect(TuiKeybind.defaultValue("session_parent")).toBe("<leader>up")
  expect(TuiKeybind.defaultValue("session_child_cycle")).toBe("<leader>right")
  expect(TuiKeybind.defaultValue("session_child_cycle_reverse")).toBe("<leader>left")
})

test("defines a collision-free transcript search default", () => {
  expect(TuiKeybind.defaultValue("session_search")).toBe("<leader>f")
  expect(Object.entries(TuiKeybind.Definitions).filter(([, item]) => item.default === "<leader>f")).toHaveLength(1)
  expect(TuiKeybind.CommandMap.session_search).toBe("session.search")
})
