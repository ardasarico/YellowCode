import { expect, spyOn, test } from "bun:test"
import { liveProvider } from "../agents/claude/provider.ts"
import { log } from "../log/log.ts"
import { createSession } from "../session/session.ts"
import { DEFAULT_MODE } from "../session/settings-file.ts"
import { createAskServer } from "./ask-server.ts"
import { createControls } from "./controls.ts"
import { pump } from "./live.ts"
import type { Requests } from "./requests.ts"
import type { Source } from "./source.ts"

test("a line that cannot be applied is logged and the next line is still handled", async () => {
  const error = spyOn(log, "error").mockImplementation(() => {})
  const response = { subtype: "success", request_id: "r1", response: {} }
  const lines = ['{"type":"system","subtype":"init"}', JSON.stringify({ type: "control_response", response })]
  let closed = false
  const source: Source = {
    events: {
      [Symbol.asyncIterator]() {
        const rest = lines.map((line) => ({ dir: "in" as const, line, at: 0 }))
        return {
          next: () =>
            Promise.resolve(rest.length ? { done: false, value: rest.shift()! } : { done: true, value: undefined }),
        }
      },
    },
    send: () => true,
    close: () => (closed = true),
  }
  const session = createSession()
  let applied = 0
  session.event = () => {
    if (applied++ === 0) throw new Error("boom")
  }
  const settled: unknown[] = []
  const requests: Requests = {
    send: () => Promise.resolve({}),
    settle: (reply) => settled.push(reply),
    close: () => {},
  }
  const controls = createControls({
    requests,
    provider: liveProvider(() => Promise.resolve([])),
    session,
    launch: { mode: DEFAULT_MODE, bypass: false },
  })
  const asks = createAskServer(
    () => {},
    () => {},
    () => [],
  )

  await pump(source, session, { requests, controls, asks })

  expect(applied).toBe(2)
  expect(settled).toHaveLength(1)
  expect(error).toHaveBeenCalledTimes(1)
  expect(closed).toBe(false)
  error.mockRestore()
})
