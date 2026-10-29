import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import type { AgentScenario } from "../../../tools/opencode/scenario.ts"
import { compact, compactFailed, usage } from "../../../tools/opencode/scenarios/usage.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { readFixture } from "./fixture.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${name}.jsonl`), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// Replays the scenario into a store and checks it against its golden, written again only with
// UPDATE_OPENCODE_GOLDENS=1 (the Claude golden test never reads it).
async function replayed(scenario: AgentScenario) {
  const store = createSession({ starting: true })
  const run = await replayAgent((driver) => scenario.run(driver), fixture(scenario.name), { store })
  expect(run.transport.unused()).toEqual([])
  const golden = join(ROOT, "fixtures", "goldens", "opencode", `${scenario.name}.json`)
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state }, null, 2)}\n`
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))
  const reports = run.outputs.flatMap((output) => ("context" in output ? [output.context] : []))
  return { ...run, store, reports }
}

test("the context is the last step's input and cache, out of the model's window", async () => {
  const { events, store, reports } = await replayed(usage)
  expect(told(events, "context.window").map((event) => event.tokens)).toEqual([200_000])
  expect(told(events, "context.used").map((event) => event.tokens)).toEqual([33_000, 84_000])
  expect(store.state.usage.context).toEqual({ used: 84_000, window: 200_000 })
  // Before the first step the session runs opencode's default model.
  expect(reports).toMatchObject([
    { model: "anthropic/claude-opus-5-5", used: 0, window: 200_000, categories: [] },
    { model: "anthropic/claude-opus-5-5", used: 84_000, window: 200_000, categories: [] },
  ])
  const [end] = told(events, "turn.end")
  expect(end?.sessionCostUsd).toBe(store.state.usage.costUsd)
  expect(end?.sessionCostUsd).toBeGreaterThan(0)
})

// The asked compaction's end comes after a seq gap, so a resync finds it stored first; the one opencode starts on its
// own is not named at all. Each is told once.
test("an asked and an automatic compaction each show once, and only the asked one is a turn of its own", async () => {
  const { events, store, kinds } = await replayed(compact).then((run) => ({
    ...run,
    kinds: run.store.state.items.map((id) => run.store.state.byId[id]?.kind),
  }))
  expect(told(events, "compacted")).toMatchObject([
    { before: 152_000, after: 180 },
    { before: 196_000, after: 180 },
  ])
  expect(told(events, "turn.end").map((end) => end.local)).toEqual([false, true, false, false, false])
  expect(kinds).toEqual([
    "user",
    "text",
    "turn-end",
    "system",
    "user",
    "text",
    "turn-end",
    "user",
    "text",
    "turn-end",
    "user",
    "system",
    "text",
    "turn-end",
  ])
  expect(store.state.compacting).toBe(false)
  expect(store.state.usage.context.used).toBe(4000)
})

// An automatic compaction that fails fails the prompt's turn with the same text, which shows once, on the turn's row.
test("a failed compaction says why once", async () => {
  const { events, store, outputs } = await replayed(compactFailed)
  const why = "Compaction summary did not match the required template"
  expect(told(events, "notice").map((notice) => notice.text)).toEqual([why])
  expect(told(events, "turn.end").map((end) => [end.local, end.error])).toEqual([
    [false, null],
    [true, null],
    [false, why],
  ])
  const history = outputs.flatMap((output) => ("history" in output ? output.history.events : []))
  expect(told(history, "notice").map((notice) => notice.text)).toEqual([why])
  expect(told(history, "turn.end").map((end) => end.error)).toEqual([why])
  const rows = store.state.items.map((id) => store.state.byId[id]?.kind)
  expect(rows).toEqual(["user", "text", "turn-end", "system", "user", "turn-end"])
})
