import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent, type DriverOutput } from "../../../tools/opencode/agent-driver.ts"
import { pick } from "../../../tools/opencode/driver.ts"
import type { AgentScenario } from "../../../tools/opencode/scenario.ts"
import { error, text, twoTurns } from "../../../tools/opencode/scenarios/turns.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { createCuts } from "./cut.ts"
import { readFixture, type HttpLine } from "./fixture.ts"
import { resync } from "./resync.ts"
import { createTranslator } from "./translate.ts"
import type { Transport } from "./transport.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${name}.jsonl`), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)
const pages = (outputs: DriverOutput[]) => outputs.flatMap((output) => ("history" in output ? [output.history] : []))

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
  const kinds = store.state.items.map((id) => store.state.byId[id]?.kind)
  return { ...run, store, kinds }
}

test("a turn streams its thinking and text, and the prompt's image goes out and comes back", async () => {
  const { events, outputs, kinds } = await replayed(text)
  const sent = fixture("text").lines.find(
    (line): line is HttpLine => line.kind === "http" && line.path.endsWith("/prompt"),
  )
  expect(sent?.body).toMatchObject({ id: "msg_prompt-1", delivery: "steer", files: [{ name: "Image 1" }] })
  expect(JSON.stringify(sent?.body)).toContain('"uri":"data:image/png;base64,')
  expect(kinds).toEqual(["user", "thinking", "text", "turn-end"])
  expect(told(events, "thinking.delta").length).toBeGreaterThan(1)
  expect(told(events, "text.delta").length).toBeGreaterThan(1)
  expect(told(events, "thinking.start")).toMatchObject([{ live: true }])
  // The history gives the prompt the id it went out with, and its image.
  const [user] = told(pages(outputs)[0]?.events ?? [], "user")
  expect(user).toMatchObject({ prompt: "prompt-1", images: [{ name: "Image 1", mediaType: "image/png" }] })
})

test("another client's prompt shows, a turn sums its steps, and a deletion elsewhere ends the session", async () => {
  const { events, outputs, kinds, store } = await replayed(twoTurns)
  expect(told(events, "user").map((event) => [event.prompt, event.text])).toEqual([
    ["prompt-1", "HOTEL one"],
    ["2", "HOTEL two, from another client"],
  ])
  const ends = told(events, "turn.end")
  expect(ends.map((end) => [end.inputTokens, end.outputTokens])).toEqual([
    [1200, 180],
    [2400, 360],
  ])
  const costs = fixture("two-turns").lines.flatMap((line) =>
    line.kind === "sse" && pick(line.event, "type") === "session.usage.updated"
      ? [pick(line.event, "data", "cost")]
      : [],
  )
  expect(ends.at(-1)?.sessionCostUsd).toBe(Number(costs.at(-1)))
  expect(told(pages(outputs)[0]?.events ?? [], "user").map((event) => event.prompt)).toEqual(["prompt-1", "2"])
  expect(kinds.at(-1)).toBe("system")
  expect(store.state.status).toBe("ended")
  expect(told(events, "ended")[0]?.problem?.text).toBe("This session was deleted in opencode")
})

test("a model API that keeps failing shows each retry, then the turn's error", async () => {
  const { events, kinds } = await replayed(error)
  expect(told(events, "retry").map((retry) => retry.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  // opencode's provider.internal is the retry row's server error.
  expect(told(events, "retry")[0]).toMatchObject({ max: null, status: 500, reason: "server_error" })
  expect(told(events, "turn.end")).toMatchObject([{ error: "The mock is broken", interrupted: false }])
  expect(kinds).toEqual(["user", "turn-end"])
})

const prompt = (id: string, said: string) => ({ id, time: { created: 1 }, type: "user" as const, text: said })

// A resync can find a prompt before its own event: another client's is told once, ours waits for the reply.
test("a resync tells another client's stored prompt once and leaves ours to its reply", () => {
  const translator = createTranslator()
  translator.sending("p1")
  const found = {
    title: null,
    cost: 0,
    messages: [prompt("msg_p1", "ours"), prompt("msg_other", "theirs")],
    running: true,
    outcome: null,
    permissions: [],
    forms: [],
    at: 2,
  }
  expect(translator.resynced(found).filter((event) => event.type.startsWith("user"))).toMatchObject([
    { type: "user", prompt: "other" },
    { type: "user.taken", prompts: ["other"] },
  ])
  expect(told(translator.resynced(found), "user")).toEqual([])
  const enqueued = {
    id: "evt_1",
    created: 3,
    type: "session.inbox.enqueued" as const,
    data: { sessionID: "ses_1", inboxID: "msg_other", item: { type: "user", payload: { text: "theirs" } } },
  }
  expect(translator.event(enqueued, 3)).toEqual([])
  const reply = { id: "p1", text: "ours", images: [], command: null, to: null, delivery: "steer" as const }
  expect(told(translator.sent({ ...reply, kept: [], context: null, shells: [] }, "msg_p1", 4), "user")).toMatchObject([
    { prompt: "p1" },
  ])
})

// Deleted elsewhere while our stream was down: the reconnect's resync ends the session as the live event does.
test("a resync that finds the session deleted ends it", async () => {
  const gone = { status: 404, body: { _tag: "SessionNotFoundError", message: "Session not found: ses_1" } }
  const transport: Transport = {
    request: () => Promise.resolve(gone),
    events: async function* () {},
    socket: () => Promise.reject(new Error("no socket")),
  }
  expect(
    await resync(
      transport,
      "ses_1",
      createTranslator(),
      createCuts(() => []),
      5,
    ),
  ).toEqual([
    { type: "ended", problem: { text: "This session was deleted in opencode", detail: [] }, final: true, at: 5 },
  ])
})
