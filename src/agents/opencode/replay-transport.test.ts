import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createDriver } from "../../../tools/opencode/driver.ts"
import { isRaw } from "../../../tools/opencode/scenario.ts"
import { scenarios } from "../../../tools/opencode/scenarios/index.ts"
import { readFixture } from "./fixture.ts"
import { replayTransport } from "./replay-transport.ts"

const fixture = (name: string) =>
  readFixture(readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "opencode", `${name}.jsonl`), "utf8"))

test("each recorded scenario replays its own steps with every exchange used", async () => {
  for (const scenario of scenarios.filter(isRaw)) {
    const transport = replayTransport(fixture(scenario.name))
    const driver = createDriver(transport, { directory: "<root>/project", timeoutMs: 2_000 })
    // oxlint-disable-next-line no-await-in-loop -- one replay at a time
    await scenario.steps(driver)
    driver.close()
    expect([scenario.name, transport.unused().length]).toEqual([scenario.name, 0])
  }
})

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (reason: unknown) => String(reason),
  )

test("an unmatched request names where it differs from the closest recorded one", async () => {
  const transport = replayTransport(fixture("raw-text"))
  const asked = { method: "POST" as const, path: "/api/session", body: { title: "other" } }
  expect(await failure(transport.request(asked))).toContain(
    "nothing recorded for POST /api/session; closest POST /api/session differs at " +
      'body.location: asked nothing, recorded {"directory":"<root>/project"}; body.title: asked "other", recorded nothing',
  )
})

test("dropped events never arrive", async () => {
  const transport = replayTransport(fixture("raw-text"))
  transport.drop(0, 1)
  const stream = new AbortController()
  const first = transport.events(stream.signal)[Symbol.asyncIterator]()
  await transport.request({ method: "POST", path: "/api/session", body: { location: { directory: "<root>/project" } } })
  const next = await first.next()
  stream.abort()
  expect(JSON.stringify(next.value)).not.toContain("server.connected")
  expect(JSON.stringify(next.value)).toContain("worktree.resolved")
})

const ws = (after: number, dir: "in" | "out", frame: unknown) =>
  JSON.stringify({ kind: "ws", t: 0, after, socket: "yellowcode", dir, frame })

test("socket frames from opencode wait for the steps before them, and sent frames must match", async () => {
  const transport = replayTransport(
    readFixture(
      [
        JSON.stringify({ kind: "meta", scenario: "socket", opencode: "2.2.0", root: "<root>" }),
        ws(0, "in", { id: 1, method: "initialize" }),
        ws(0, "out", { id: 1, result: {} }),
        ws(1, "in", { id: 2, method: "tools/list" }),
        JSON.stringify({ kind: "sse", t: 0, after: 1, event: { id: "evt_1", type: "mcp.status.changed", data: {} } }),
      ].join("\n"),
    ),
  )
  const socket = await transport.socket("yellowcode")
  const frames = socket.frames[Symbol.asyncIterator]()
  const stream = new AbortController()
  const events = transport.events(stream.signal)[Symbol.asyncIterator]()
  expect((await frames.next()).value).toEqual({ id: 1, method: "initialize" })
  const second = frames.next()
  const event = events.next()
  const early = await Promise.race([
    second.then(() => "frame"),
    event.then(() => "event"),
    Bun.sleep(20).then(() => ""),
  ])
  expect(early).toBe("")
  expect(() => socket.send({ id: 1, result: { other: true } })).toThrow(
    "frame.result.other: asked true, recorded nothing",
  )
  socket.send({ id: 1, result: {} })
  expect((await second).value).toEqual({ id: 2, method: "tools/list" })
  expect(JSON.stringify((await event).value)).toContain("mcp.status.changed")
  expect(transport.unused()).toEqual([])
  socket.close()
  stream.abort()
  expect((await frames.next()).done).toBe(true)
})
