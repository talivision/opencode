/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function session(id: string, title = id) {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    title,
    time: { created: 0, updated: 0 },
    version: "1.0.0",
    directory: "/tmp/opencode/packages/tui",
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps session lists in code-unit order for binary updates", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session") return json([session("ses_a"), session("ses_Z")])
      return undefined
    }, tmp.path)

    try {
      expect(sync.data.session.map((item) => item.id)).toEqual(["ses_Z", "ses_a"])

      emit({
        directory: "/tmp/other",
        project: "proj_test",
        payload: {
          id: "evt_session_updated",
          type: "session.updated",
          properties: { sessionID: "ses_aa", info: session("ses_aa") },
        },
      })
      await wait(() => sync.data.session.length === 3)

      expect(sync.data.session.map((item) => item.id)).toEqual(["ses_Z", "ses_a", "ses_aa"])
      expect(sync.session.get("ses_aa")?.title).toBe("ses_aa")
    } finally {
      app.renderer.destroy()
    }
  })

  test("ignores removals for messages and parts that were never hydrated", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sdk, sync } = await mount(undefined, tmp.path)

    try {
      const messages = JSON.stringify(sync.data.message)
      const parts = JSON.stringify(sync.data.part)
      emit(
        global({
          id: "evt_unknown_message_removed",
          type: "message.removed",
          properties: { sessionID: "ses_unknown", messageID: "msg_unknown" },
        }),
      )
      emit(
        global({
          id: "evt_unknown_part_removed",
          type: "message.part.removed",
          properties: { sessionID: "ses_unknown", messageID: "msg_unknown", partID: "prt_unknown" },
        }),
      )
      await Bun.sleep(30)

      expect(sdk.dispatchErrors()).toBe(0)
      expect(JSON.stringify(sync.data.message)).toBe(messages)
      expect(JSON.stringify(sync.data.part)).toBe(parts)
    } finally {
      app.renderer.destroy()
    }
  })

  test("continues a batch after a handler throws", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sdk, sync } = await mount(undefined, tmp.path)
    const sessionID = "ses_batch_survives"
    const info = {
      id: "msg_after_poison",
      sessionID,
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    }
    sdk.event.on("event", (event) => {
      if (event.payload.type === "message.removed") throw new TypeError("poison")
    })

    try {
      emit(branchEvent("warmup"))
      emit(
        global({
          id: "evt_poison",
          type: "message.removed",
          properties: { sessionID: "ses_unknown", messageID: "msg_unknown" },
        }),
      )
      emit(global({ id: "evt_after_poison", type: "message.updated", properties: { sessionID, info } }))
      await wait(() => sync.data.message[sessionID]?.[0]?.id === info.id)

      expect(sdk.dispatchErrors()).toBe(1)
      expect(sync.data.message[sessionID]).toEqual([info])
    } finally {
      app.renderer.destroy()
    }
  })

  test("coalesces dispatch-error heals for one batch", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_dispatch_heal"
    const info = session(sessionID)
    let lists = 0
    let messages = 0
    const transcript = {
      info: {
        id: "msg_dispatch_heal",
        sessionID,
        role: "user" as const,
        time: { created: 1 },
        agent: "build",
        model: { providerID: "test", modelID: "model" },
      },
      parts: [],
    }
    const { app, emit, sdk, sync } = await mount((url) => {
      if (url.pathname === "/session") {
        lists += 1
        return json([info])
      }
      if (url.pathname === `/session/${sessionID}`) return json(info)
      if (url.pathname === `/session/${sessionID}/message`) {
        messages += 1
        return json([transcript])
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`)
        return json([])
      return undefined
    }, tmp.path)
    const poison = (event: GlobalEvent) => {
      if (event.payload.type === "message.removed") throw new Error("dispatch failed")
    }
    sdk.event.on("event", (event) => poison(event))
    sdk.event.on("event", (event) => poison(event))

    try {
      await sync.session.sync(sessionID)
      expect(messages).toBe(1)

      emit(branchEvent("warmup"))
      emit(
        global({
          id: "evt_dispatch_heal",
          type: "message.removed",
          properties: { sessionID: "ses_unknown", messageID: "msg_unknown" },
        }),
      )
      await wait(() => sdk.dispatchErrors() === 2 && lists === 2 && messages === 2)
      await Bun.sleep(30)

      expect(lists).toBe(2)
      expect(messages).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })

  test("queues reconnect heals and refetches fully synced transcripts", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_reconnect"
    let lists = 0
    let messages = 0
    const info = session(sessionID)
    let releaseList!: () => void
    const blockedList = new Promise<Response>((resolve) => {
      releaseList = () => resolve(json([info]))
    })
    const message = (id: string, created: number) => ({
      info: {
        id,
        sessionID,
        role: "user" as const,
        time: { created },
        agent: "build",
        model: { providerID: "test", modelID: "model" },
      },
      parts: [],
    })
    const { app, reconnect, sync } = await mount((url) => {
      if (url.pathname === "/session") {
        lists += 1
        if (lists === 2) return blockedList
        return json([info])
      }
      if (url.pathname === `/session/${sessionID}`) return json(info)
      if (url.pathname === `/session/${sessionID}/message`) {
        messages += 1
        return json(messages === 1 ? [message("msg_before", 1)] : [message("msg_before", 1), message("msg_gap", 2)])
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`)
        return json([])
      return undefined
    }, tmp.path)

    try {
      await sync.session.sync(sessionID)
      await sync.session.sync(sessionID)
      expect(messages).toBe(1)

      reconnect()
      await wait(() => lists === 2)
      reconnect()
      releaseList()
      await wait(() => lists === 3 && messages === 3)

      expect(sync.data.message[sessionID].map((item) => item.id)).toEqual(["msg_before", "msg_gap"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })
})
