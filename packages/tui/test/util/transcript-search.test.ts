import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { findMatches, segmentTranscriptMatches } from "../../src/util/transcript-search"

const user: UserMessage = {
  id: "message-user",
  sessionID: "session",
  role: "user",
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
  time: { created: 1 },
}

const assistant: AssistantMessage = {
  id: "message-assistant",
  sessionID: "session",
  role: "assistant",
  agent: "build",
  modelID: "model",
  providerID: "provider",
  mode: "build",
  parentID: user.id,
  path: { cwd: "/workspace", root: "/workspace" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 2, completed: 3 },
}

describe("findMatches", () => {
  test("matches case-insensitive substrings in transcript order", () => {
    const parts: Record<string, Part[]> = {
      [user.id]: [
        {
          id: "part-user",
          sessionID: "session",
          messageID: user.id,
          type: "text",
          text: "Alpha from the user",
        },
        {
          id: "part-user-second",
          sessionID: "session",
          messageID: user.id,
          type: "text",
          text: "Alpha again",
        },
      ],
      [assistant.id]: [
        {
          id: "part-assistant",
          sessionID: "session",
          messageID: assistant.id,
          type: "text",
          text: "The assistant says ALPHA too",
        },
      ],
    }

    expect(findMatches([user, assistant], parts, "alpha")).toEqual([
      { messageID: user.id, preview: "Alpha from the user\n\nAlpha again" },
      { messageID: assistant.id, partID: "part-assistant", preview: "The assistant says ALPHA too" },
    ])
  })

  test("excludes synthetic and ignored user text and non-text assistant parts", () => {
    const parts: Record<string, Part[]> = {
      [user.id]: [
        {
          id: "part-synthetic",
          sessionID: "session",
          messageID: user.id,
          type: "text",
          text: "needle synthetic",
          synthetic: true,
        },
        {
          id: "part-ignored",
          sessionID: "session",
          messageID: user.id,
          type: "text",
          text: "needle ignored",
          ignored: true,
        },
      ],
      [assistant.id]: [
        {
          id: "part-tool",
          sessionID: "session",
          messageID: assistant.id,
          type: "tool",
          callID: "call",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: "needle tool output",
            title: "Tool",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      ],
    }

    expect(findMatches([user, assistant], parts, "needle")).toEqual([])
  })

  test("returns no matches for an empty query", () => {
    expect(findMatches([user, assistant], {}, "")).toEqual([])
  })
})

describe("segmentTranscriptMatches", () => {
  test("segments multiple case-insensitive occurrences", () => {
    expect(segmentTranscriptMatches("Alpha and ALPHA again", "alpha")).toEqual([
      { text: "Alpha", match: true },
      { text: " and ", match: false },
      { text: "ALPHA", match: true },
      { text: " again", match: false },
    ])
  })

  test("passes through text without a match", () => {
    expect(segmentTranscriptMatches("plain text", "missing")).toEqual([{ text: "plain text", match: false }])
  })

  test("advances past matches without emitting overlapping ranges", () => {
    expect(segmentTranscriptMatches("banana", "ana")).toEqual([
      { text: "b", match: false },
      { text: "ana", match: true },
      { text: "na", match: false },
    ])
  })
})
