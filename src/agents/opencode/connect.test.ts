import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import { connect } from "../../../tools/opencode/scenarios/connect.ts"
import { createSession, type SessionStore } from "../../session/session.ts"
import { readFixture, type SseLine } from "./fixture.ts"
import type { ReplayTransport } from "./replay-transport.ts"

const fixture = () =>
  readFixture(readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "opencode", "connect.jsonl"), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

async function replay(prepare?: (transport: ReplayTransport) => void) {
  const store: SessionStore = createSession({ starting: true })
  const run = await replayAgent((driver) => connect.run(driver), fixture(), { store, prepare })
  return { store, ...run }
}

test("the connect scenario replays with every exchange used and ends idle after one turn", async () => {
  const { store, events, transport } = await replay()
  expect(transport.unused()).toEqual([])
  expect(store.state.status).toBe("ended")
  const kinds = store.state.items.map((id) => {
    const item = store.state.byId[id]
    return item?.kind === "tool" ? `tool ${item.status}` : item?.kind
  })
  expect(kinds).toEqual(["user", "text", "tool done", "ask", "text", "turn-end"])
  expect(events.filter((event) => event.type === "ready")).toHaveLength(1)
})

// Everything of the first stream from the turn's first step on, but the title, which shows the one sequence gap
// opencode always leaves (a usage record the stream does not carry). So both replays make the same requests.
const typeOf = (line: SseLine) => /"type":"([^"]+)"/.exec(JSON.stringify(line.event))?.[1]

function dropTheMiddle(transport: ReplayTransport): void {
  const events = fixture().lines.filter((line): line is SseLine => line.kind === "sse")
  const from = events.findIndex((line) => typeOf(line) === "session.step.started")
  const end = events.findIndex((line) => (line.stream ?? 0) > 0)
  expect(from).toBeGreaterThan(0)
  events.forEach((line, index) => {
    if (index >= from && index < end && typeOf(line) !== "session.renamed") transport.drop(index, index + 1)
  })
}

test("a turn whose middle stretch of events is lost ends in the same state once the reconnect resyncs", async () => {
  const full = await replay()
  const cut = await replay(dropTheMiddle)
  expect(cut.events.length).toBeLessThan(full.events.length)
  expect(JSON.stringify(cut.store.state)).toBe(JSON.stringify(full.store.state))
})
