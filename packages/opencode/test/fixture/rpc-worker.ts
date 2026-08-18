import { Rpc } from "../../src/util/rpc"

export const rpc = {
  succeed(input: string) {
    return input
  },
  async fail() {
    throw new TypeError("worker handler failed")
  },
}

Rpc.listen(rpc)
