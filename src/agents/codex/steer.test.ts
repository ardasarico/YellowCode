import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/codex/agent-driver.ts"
import type { AgentScenario } from "../../../tools/codex/scenario.ts"
import {
  bgShell,
  cut,
  cutElsewhere,
  cutLegacy,
  interrupt,
  queued,
  steer,
  stopAgent,
} from "../../../tools/codex/scenarios/steer.ts"
import type { Prompt } from "../../agent/agent.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { readFixture } from "./fixture.ts"
import { createDelivery } from "./steer.ts"
import { RpcError, type Rpc } from "./transport.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "codex", `${name}.jsonl`), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// The replay checks every request we sent against the recorded one, so a wrong revert or steer fails here.
async function replayed(scenario: AgentScenario) {
  const store = createSession({ starting: true })
  const run = await replayAgent((driver) => scenario.run(driver), fixture(scenario.name), { store })
  expect(run.transports.map((transport) => transport.unused())).toEqual(run.transports.map(() => []))
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state }, null, 2)}\n`
  const golden = join(ROOT, "fixtures", "goldens", "codex", `${scenario.name}.json`)
  if (process.env["UPDATE_CODEX_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))
  return { events, store, outputs: run.outputs }
}

const queueOf = (store: ReturnType<typeof createSession>) =>
  Object.values(store.state.byId).flatMap((item) => (item.kind === "user" ? [[item.uuid, item.queue]] : []))

test("a steered prompt is taken into the running turn and waits no more", async () => {
  const { events, store } = await replayed(steer)
  expect(told(events, "user.taken").map((event) => event.prompts)).toEqual([["prompt-2"]])
  expect(queueOf(store)).toEqual([
    ["prompt-1", null],
    ["prompt-2", null],
  ])
})

test("a queued prompt runs as a turn of its own once the turn ends", async () => {
  const { events, store } = await replayed(queued)
  expect(told(events, "user.taken").map((event) => event.prompts)).toEqual([["prompt-2"]])
  expect(told(events, "turn.open")).toHaveLength(2)
  expect(queueOf(store).map(([, queue]) => queue)).toEqual([null, null])
})

test("an interrupt stops the turn, its command goes on in the background, and the steered prompt runs next", async () => {
  const { events, store } = await replayed(interrupt)
  expect(told(events, "interrupt").map((event) => event.state)).toEqual(["asked", "answered"])
  expect(told(events, "turn.end").map((event) => event.interrupted)).toEqual([true, false])
  expect(told(events, "task.start").map((event) => [event.kind, event.background])).toEqual([["shell", true]])
  expect(told(events, "user.taken").map((event) => event.prompts)).toEqual([["prompt-2"]])
  expect(told(events, "user.dropped")).toEqual([])
  expect(queueOf(store).map(([, queue]) => queue)).toEqual([null, null])
})

test("our own cuts and reverts tell no cut back, and the reverted thread is listed once by its first prompt", async () => {
  const { events, outputs } = await replayed(cut)
  expect(told(events, "cut")).toEqual([])
  const listed = outputs.flatMap((output) => ("sessions" in output ? output.sessions : []))
  expect(listed.map((entry) => entry.firstPrompt)).toEqual(["VICTOR one"])
})

test("a legacy thread's cut goes on in a copy, and the session names the copy", async () => {
  const { events, outputs } = await replayed(cutLegacy)
  const ids = told(events, "info").map((event) => event.info.id)
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
  const listed = outputs.flatMap((output) => ("sessions" in output ? output.sessions : []))
  expect(listed.map((entry) => entry.ref.id)).toContain(ids[1] ?? "")
})

test("another client's cut names the first prompt it took out", async () => {
  const { events } = await replayed(cutElsewhere)
  expect(told(events, "cut").map((event) => event.before)).toEqual(["prompt-2"])
})

test("a command left running is a background shell the user can stop", async () => {
  const { events } = await replayed(bgShell)
  const [start] = told(events, "task.start")
  expect([start?.kind, start?.background]).toEqual(["shell", true])
  expect(told(events, "task.stopping").map((event) => event.id)).toEqual([start?.id ?? ""])
  expect(told(events, "task.end").map((event) => [event.state, event.report?.stoppedByUser])).toEqual([
    ["stopped", true],
  ])
})

test("a stopped subagent ends stopped by the user", async () => {
  const { events } = await replayed(stopAgent)
  expect(told(events, "task.end").map((event) => [event.state, event.report?.stoppedByUser])).toEqual([
    ["stopped", true],
  ])
})

const prompt = (id: string): Prompt => ({
  id,
  text: "more",
  images: [],
  command: null,
  to: null,
  delivery: "steer",
  kept: [],
  shells: [],
})

// A turn that ends while the steer is on its way leaves nothing to steer; the prompt starts a turn of its own.
test("a steer refused because the turn ended starts a turn", async () => {
  const sent: string[] = []
  const rpc: Rpc = {
    request(method) {
      sent.push(method)
      if (method === "turn/steer") return Promise.reject(new RpcError(method, -32600, "no active turn to steer"))
      return Promise.resolve({})
    },
    notify() {},
    respond() {},
    fail() {},
    incoming: (async function* () {})(),
    exited: new Promise(() => {}),
    close: () => Promise.resolve(),
  }
  const delivery = createDelivery({ rpc: () => rpc, thread: () => "thread", running: () => "turn" })
  await delivery.send(prompt("p1"), [], "none")
  expect(sent).toEqual(["turn/steer", "turn/start"])
})
