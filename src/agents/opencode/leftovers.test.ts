import { expect, test } from "bun:test"
import { childTitle, deleteLeftovers } from "./leftovers.ts"
import type { Reply, Request, Transport } from "./transport.ts"

const row = (id: string, title: string) => ({
  id,
  projectID: "p",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  location: { directory: "/work" },
  title,
})

test("only a marked session whose YellowCode is gone is deleted", async () => {
  const gone = Bun.spawn(["true"])
  await gone.exited
  const asked: string[] = []
  const transport: Transport = {
    request(req: Request): Promise<Reply> {
      asked.push(`${req.method} ${req.path}`)
      if (req.method === "DELETE") return Promise.resolve({ status: 204, body: null })
      const data = [
        row("ses_left", childTitle(undefined, gone.pid)),
        row("ses_ours", childTitle()),
        row("ses_user", `Talk about yc-child:${gone.pid}`),
      ]
      return Promise.resolve({ status: 200, body: { data, cursor: {} } })
    },
    events: () => (async function* () {})(),
    socket: () => Promise.reject(new Error("no socket")),
  }
  await deleteLeftovers(transport)
  expect(asked.filter((line) => line.startsWith("DELETE"))).toEqual(["DELETE /api/session/ses_left"])
})
