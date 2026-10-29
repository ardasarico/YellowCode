import { expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createDriver } from "../../../../tools/opencode/driver.ts"
import { isRaw } from "../../../../tools/opencode/scenario.ts"
import { scenarios } from "../../../../tools/opencode/scenarios/index.ts"
import { log } from "../../../log/log.ts"
import { readFixture } from "../fixture.ts"
import { replayTransport } from "../replay-transport.ts"
import { answerOf, dataOf, envelope, pageOf } from "./envelope.ts"
import { createEventReader, type ReadEvent } from "./events.ts"
import { message } from "./messages.ts"
import { session } from "./session.ts"

const DIR = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "opencode")
const fixture = (name: string) => readFixture(readFileSync(join(DIR, `${name}.jsonl`), "utf8"))
const SCENARIOS = scenarios.map((scenario) => scenario.name)

test("replaying every scenario reads each frame as a known event, with times from the envelope", async () => {
  expect(scenarios.map((scenario) => scenario.name)).toContain("raw-hello")
  for (const scenario of scenarios.filter(isRaw)) {
    const recorded = fixture(scenario.name)
    const transport = replayTransport(recorded)
    const count = recorded.lines.filter((line) => line.kind === "sse").length
    const stream = new AbortController()
    const reading = (async () => {
      const read = createEventReader()
      const results: ReadEvent[] = []
      for await (const frame of transport.events(stream.signal)) {
        results.push(read(frame))
        if (results.length === count) break
      }
      return results
    })()
    const driver = createDriver(transport, { directory: "<root>/project", timeoutMs: 2_000 })
    // oxlint-disable-next-line no-await-in-loop -- one replay at a time
    await scenario.steps(driver)
    driver.close()
    // oxlint-disable-next-line no-await-in-loop -- one replay at a time
    const results = await reading
    stream.abort()
    expect([scenario.name, results.length, results.filter((result) => result.kind !== "event")]).toEqual([
      scenario.name,
      count,
      [],
    ])
    const created = recorded.lines.flatMap((line) => {
      const at = line.kind === "sse" ? envelope.parse(line.event).created : undefined
      return at === undefined ? [] : [at]
    })
    expect(results.map((result) => result.at).filter((at) => at !== 0)).toEqual(created)
  }
})

test("recorded session and message answers fit their schemas, with no entry or part left unknown", () => {
  for (const name of SCENARIOS)
    for (const line of fixture(name).lines) {
      if (line.kind !== "http") continue
      const reply = { status: line.status, body: line.response }
      if (line.path === "/api/session")
        expect([
          name,
          answerOf(reply, line.method === "GET" ? pageOf(session) : dataOf(session), "session").kind,
        ]).toEqual([name, "ok"])
      if (!line.path.endsWith("/message")) continue
      const answer = answerOf(reply, pageOf(message), "messages")
      if (answer.kind !== "ok") throw new Error(`${name}: messages are ${answer.kind}`)
      const entries = answer.value.data
      const parts = entries.flatMap((entry) => (entry.type === "assistant" ? entry.content : []))
      expect([name, [...entries, ...parts].filter((item) => item.type === "unknown")]).toEqual([name, []])
    }
})

const delta = (data: unknown) => ({ id: "evt_1", created: 5, type: "session.text.delta", data })

test("an extra field passes, a wrong type is unreadable and an unknown type is only seen", () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {})
  const info = spyOn(log, "info").mockImplementation(() => {})
  try {
    const read = createEventReader()
    const fields = { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 }
    const extra = read({ ...delta({ ...fields, delta: "hi", later: { x: 1 } }), later: true })
    expect(extra.kind === "event" && extra.event.type === "session.text.delta" && extra.event.data.delta).toBe("hi")
    expect(read(delta({ ...fields, delta: 42 }))).toEqual({
      at: 5,
      durable: null,
      kind: "unreadable",
      what: "session.text.delta",
    })
    expect(read({ id: "evt_2", type: 7, data: {} })).toEqual({
      at: 5,
      durable: null,
      kind: "unreadable",
      what: "event",
    })
    const durable = { aggregateID: "ses_1", seq: 3, version: 1 }
    expect(read({ id: "evt_3", created: 9, type: "session.new.thing", data: { text: "private" }, durable })).toEqual({
      at: 9,
      durable: { aggregateID: "ses_1", seq: 3 },
      kind: "unknown",
      type: "session.new.thing",
    })
    read({ id: "evt_4", created: 10, type: "session.new.thing", data: {} })
    expect(info).toHaveBeenCalledTimes(1)
    expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain("private")
  } finally {
    warn.mockRestore()
    info.mockRestore()
  }
})

test("an answer reads as its data, opencode's error or unreadable", () => {
  const schema = dataOf(session)
  expect(answerOf({ status: 404, body: { _tag: "SessionNotFoundError", message: "gone" } }, schema, "session")).toEqual(
    {
      kind: "error",
      status: 404,
      tag: "SessionNotFoundError",
      message: "gone",
    },
  )
  expect(answerOf({ status: 200, body: { data: { id: 1 } } }, schema, "session")).toEqual({
    kind: "unreadable",
    what: "session",
  })
  const later = message.parse({ id: "msg_9", time: { created: 1 }, type: "handoff", note: "x" })
  expect(later).toEqual({ type: "unknown", originalType: "handoff" })
})
