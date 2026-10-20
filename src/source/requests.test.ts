import { expect, test } from "bun:test"
import { interruptRequest } from "../protocol/outgoing.ts"
import { createRequests, RequestError } from "./requests.ts"

const rejection = (reply: Promise<unknown>) =>
  reply.then(
    () => null,
    (error: unknown) => (error instanceof RequestError ? error.message : error),
  )

test("a success reply resolves with its response, an error reply rejects with its text", async () => {
  const written: string[] = []
  const requests = createRequests((line) => {
    written.push(line)
    return true
  })
  const first = requests.send(interruptRequest)
  const second = requests.send(interruptRequest)
  expect(written).toEqual([interruptRequest("yc-1"), interruptRequest("yc-2")])

  const failed = { subtype: "error", request_id: "yc-2", error: "not now" }
  requests.settle({ subtype: "success", request_id: "yc-1", response: { still_queued: [] } })
  requests.settle(failed)
  expect(await first).toEqual({ still_queued: [] })
  expect(await rejection(second)).toBe("not now")
})

test("a request without a reply times out, and a late reply is ignored", async () => {
  const requests = createRequests(() => true)
  const reply = requests.send(interruptRequest, 5)
  expect(await rejection(reply)).toBe("yc-1 timed out after 5 ms")
  requests.settle({ subtype: "success", request_id: "yc-1", response: {} })
})

test("close rejects pending and later requests", async () => {
  const requests = createRequests(() => true)
  const pending = requests.send(interruptRequest)
  requests.close("Claude Code exited")
  expect(await rejection(pending)).toBe("Claude Code exited")
  expect(await rejection(requests.send(interruptRequest))).toBe("Claude Code exited")
})
