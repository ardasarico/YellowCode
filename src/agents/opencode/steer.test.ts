import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import type { AgentScenario } from "../../../tools/opencode/scenario.ts"
import { interrupt, steer } from "../../../tools/opencode/scenarios/steer.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession, type SessionStore } from "../../session/session.ts"
import { readFixture, type HttpLine } from "./fixture.ts"
import { createTranslator } from "./translate.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${name}.jsonl`), "utf8"))
const requests = (name: string, path: string) =>
  fixture(name).lines.filter((line): line is HttpLine => line.kind === "http" && line.path.endsWith(path))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// The golden is written again only with UPDATE_OPENCODE_GOLDENS=1.
async function replayed(scenario: AgentScenario) {
  const store = createSession({ starting: true })
  // The session and its queue as each turn ended, before close() ends whatever still waits.
  const ends: { status: string; queue: unknown[][] }[] = []
  const watched = {
    ...store,
    event(event: AgentEvent) {
      store.event(event)
      if (event.type === "turn.end") ends.push({ status: store.state.status, queue: queueOf(store) })
    },
  }
  const run = await replayAgent((driver) => scenario.run(driver), fixture(scenario.name), { store: watched })
  expect(run.transport.unused()).toEqual([])
  const golden = join(ROOT, "fixtures", "goldens", "opencode", `${scenario.name}.json`)
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state }, null, 2)}\n`
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))
  return { ...run, store, ends }
}

// Each prompt's text and where it stands in the queue.
const queueOf = (store: SessionStore) =>
  Object.values(store.state.byId).flatMap((item) => (item.kind === "user" ? [[item.text, item.queue]] : []))

test("a steered prompt is taken in at the next step, a queued one after the last, and a cancelled one is dropped", async () => {
  const { events, ends } = await replayed(steer)
  expect(requests("steer", "/prompt").map((line) => pick(line.body))).toEqual([
    ["msg_prompt-1", "steer"],
    ["msg_prompt-2", "steer"],
    ["msg_prompt-3", "queue"],
    ["msg_prompt-4", "queue"],
  ])
  // Each step's start, and what each step took in before it.
  const order = events.flatMap((event) =>
    event.type === "turn.step" ? ["step"] : event.type === "user.taken" ? event.prompts : [],
  )
  expect(order).toEqual(["prompt-1", "step", "prompt-2", "step", "prompt-3", "step"])
  expect(told(events, "user.dropped")).toMatchObject([{ prompt: "prompt-4" }])
  expect(ends).toEqual([
    {
      status: "idle",
      queue: [
        ["JULIET read the readme", null],
        ["JULIET steered: say hello", null],
        ["JULIET queued: then sum up", null],
        ["JULIET queued: never mind", "not sent"],
      ],
    },
  ])
})

test("an interrupt keeps the text so far, the steered prompt runs next, and one with no turn is refused", async () => {
  const { events, store, ends } = await replayed(interrupt)
  expect(requests("interrupt", "/interrupt").map((line) => [line.query, line.response])).toEqual([
    [{ resume: "true" }, { interrupted: true }],
    [{ resume: "true" }, { interrupted: false }],
  ])
  expect(told(events, "interrupt").map((event) => event.state)).toEqual(["asked", "answered", "asked", "refused"])
  expect(told(events, "turn.end").map((end) => end.interrupted)).toEqual([true, false])
  const texts = Object.values(store.state.byId).flatMap((item) => (item.kind === "text" ? [item.markdown] : []))
  expect(texts).toEqual(["Starting a long answer, and then", "Stopped there. What else?"])
  expect(ends.at(-1)).toEqual({
    status: "idle",
    queue: [
      ["ZULU write something long", null],
      ["ZULU steered while it hangs", null],
    ],
  })
  expect(store.state.interrupting).toBe(false)
})

function pick(body: unknown): unknown[] {
  const fields = typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {}
  return [fields["id"], fields["delivery"]]
}

const prompt = (id: string) => ({
  id,
  text: id,
  images: [],
  command: null,
  to: null,
  delivery: "queue" as const,
  kept: [],
  shells: [],
})

// One cancelled before its reply came is dropped with it, and one taken in while the stream was down is taken by the
// resync, once.
test("a prompt cancelled before its reply is dropped, and one a resync finds stored is taken once", () => {
  const translator = createTranslator()
  const inbox = (type: "session.inbox.cancelled" | "session.inbox.delivered", message: string) =>
    translator.event({ id: "evt_1", created: 1, type, data: { sessionID: "ses_1", inboxID: message } }, 1)
  translator.sending("p1")
  expect(inbox("session.inbox.cancelled", "msg_p1")).toEqual([])
  expect(translator.sent(prompt("p1"), "msg_p1", 2).map((event) => event.type)).toEqual(["user", "user.dropped"])

  translator.sending("p2")
  expect(translator.sent(prompt("p2"), "msg_p2", 3).map((event) => event.type)).toEqual(["user"])
  const found = {
    title: null,
    cost: 0,
    messages: [{ id: "msg_p2", time: { created: 3 }, type: "user" as const, text: "p2" }],
    running: true,
    outcome: null,
    permissions: [],
    forms: [],
    at: 4,
  }
  expect(told(translator.resynced(found), "user.taken")).toMatchObject([{ prompts: ["p2"] }])
  expect(inbox("session.inbox.delivered", "msg_p2")).toEqual([])
})

// A resync from a shown prompt of another client's, while our command waits, leaves that prompt alone.
test("a command waiting for its message takes the first one not shown yet", () => {
  const translator = createTranslator()
  const enqueued = (message: string, text: string) =>
    translator.event(
      {
        id: "evt_1",
        created: 1,
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_1", inboxID: message, item: { type: "user", payload: { text } } },
      },
      1,
    )
  expect(told(enqueued("msg_other", "theirs"), "user")).toMatchObject([{ prompt: "other", text: "theirs" }])
  translator.commanding({ ...prompt("p1"), text: "/hello the team" })
  const found = {
    title: null,
    cost: 0,
    messages: [{ id: "msg_other", time: { created: 1 }, type: "user" as const, text: "theirs" }],
    running: true,
    outcome: null,
    permissions: [],
    forms: [],
    at: 2,
  }
  expect(told(translator.resynced(found), "user")).toEqual([])
  expect(told(enqueued("msg_cmd", "Say hello to the team."), "user")).toMatchObject([
    { prompt: "p1", text: "/hello the team" },
  ])
  expect(translator.messageFor("p1")).toBe("msg_cmd")
})
