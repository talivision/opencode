import { expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"
import type { rpc } from "../fixture/rpc-worker"

test("rejects calls when the worker handler rejects", async () => {
  const worker = new Worker(new URL("../fixture/rpc-worker.ts", import.meta.url).href)
  const client = Rpc.client<typeof rpc>(worker)

  try {
    await expect(client.call("fail", undefined)).rejects.toMatchObject({
      name: "TypeError",
      message: "worker handler failed",
    })
    await expect(client.call("succeed", "still connected")).resolves.toBe("still connected")
  } finally {
    worker.terminate()
  }
})
