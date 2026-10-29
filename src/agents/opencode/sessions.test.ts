import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent, type DriverOutput } from "../../../tools/opencode/agent-driver.ts"
import { fork, sessions, title } from "../../../tools/opencode/scenarios/sessions.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession, loadHistory } from "../../session/session.ts"
import { readFixture, type HttpLine } from "./fixture.ts"
import { historyPage } from "./history.ts"
import { listSessions } from "./sessions.ts"
import type { Reply, Request, Transport } from "./transport.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${name}.jsonl`), "utf8"))
// Written again only with UPDATE_OPENCODE_GOLDENS=1; the Claude golden test never reads it.
const GOLDEN = join(ROOT, "fixtures", "goldens", "opencode", "sessions.json")

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const listed = (outputs: DriverOutput[]) => outputs.flatMap((output) => ("sessions" in output ? output.sessions : []))
const pages = (outputs: DriverOutput[]) => outputs.flatMap((output) => ("history" in output ? [output.history] : []))
const said = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === "user" || event.type === "text.end" ? [event.text] : []))

function serving(answer: (req: Request) => unknown): Transport & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    request(req): Promise<Reply> {
      asked.push(`${req.method} ${req.path} ${new URLSearchParams(req.query).toString()}`)
      return Promise.resolve({ status: 200, body: answer(req) })
    },
    events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
    socket: () => Promise.reject(new Error("no socket")),
  }
}

test("the list leaves out archived, unprompted and other folders' sessions and subagent runs", async () => {
  const recorded = fixture("sessions")
  const { outputs, transport } = await replayAgent((driver) => sessions.run(driver), recorded)
  expect(transport.unused()).toEqual([])
  const entries = listed(outputs)
  // ses_2 is in the folder but was never prompted.
  expect(entries.map((entry) => [entry.ref.id, entry.title, entry.firstPrompt])).toEqual([
    ["ses_1", "Reading the readme", "ECHO what is in the readme"],
  ])
  // The service filtered them; every one of them was there to leave out.
  const all = recorded.lines.find(
    (line): line is HttpLine => line.kind === "http" && line.path === "/api/session" && line.method === "GET",
  )
  expect(JSON.stringify(all?.response)).toContain('"parentID":"ses_1"')
  expect(JSON.stringify(all?.response)).toContain('"archived":')
  expect(JSON.stringify(all?.response)).toContain('"directory":"<root>/home"')
  // A service that ignores the filters still lists only the two; an untitled one is named by its prompt, on one line.
  const unfiltered = serving((req) =>
    req.path === "/api/session"
      ? all?.response
      : { data: [user("msg_1", "\u001b[1mfix\u001b[0m the\nbuild")], cursor: {} },
  )
  const again = await listSessions(unfiltered, "<root>/project")
  expect(again.map((entry) => [entry.ref.id, entry.title, entry.firstPrompt])).toEqual([
    ["ses_2", "fix the build", "fix the build"],
    ["ses_1", "Reading the readme", "fix the build"],
  ])
})

test("a history page reads the stored turns back and hides what a staged revert drops", async () => {
  const { outputs } = await replayAgent((driver) => sessions.run(driver), fixture("sessions"))
  const [before, after] = pages(outputs)
  if (!before || !after) throw new Error("the scenario reads the history twice")
  expect(said(before.events)).toContain("ECHO anything else?")
  expect(said(after.events)).toEqual([
    "ECHO what is in the readme",
    "Let me read it.",
    "It describes a small demo project.",
    "ECHO and the source?",
    "There is one source file, src/a.ts.",
  ])
  const store = createSession()
  loadHistory(store, after.events)
  const got = `${JSON.stringify({ page: after, state: store.state }, null, 2)}\n`
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") {
    mkdirSync(join(GOLDEN, ".."), { recursive: true })
    writeFileSync(GOLDEN, got)
  }
  expect(got).toBe(readFileSync(GOLDEN, "utf8"))
})

const user = (id: string, text = `prompt ${id}`) => ({ id, type: "user", time: { created: 1 }, text })
const idle = (id: string) => ({ id, type: "idle", time: { created: 1 }, outcome: "succeeded" })
const step = (id: string) => ({
  id,
  type: "assistant",
  time: { created: 1 },
  agent: "build",
  model: { id: "m", providerID: "p" },
  content: [{ type: "text", text: `step ${id}` }],
})

test("a page reads on until it starts at a prompt, past what a staged revert drops", async () => {
  const replies: Record<string, unknown[]> = {
    first: [idle("m9"), user("m8")],
    c1: [idle("m7"), step("m6")],
    c2: [step("m5"), user("m4")],
    c3: [idle("m3"), step("m2")],
    c4: [user("m1")],
  }
  const after: Record<string, string> = { first: "c1", c1: "c2", c2: "c3", c3: "c4", c4: "c5" }
  const transport = serving((req) => {
    if (req.path === "/api/session/s") return { data: { ...SESSION, revert: { messageID: "m8" } } }
    const at = req.query?.["cursor"] ?? "first"
    return { data: replies[at] ?? [], cursor: { next: after[at] ?? null } }
  })
  const newest = await historyPage(transport, "s", null, 2)
  expect(said(newest.events)).toEqual(["prompt m4", "step m5", "step m6"])
  expect(newest.earlier).not.toBeNull()
  const older = await historyPage(transport, "s", newest.earlier, 2)
  expect(said(older.events)).toEqual(["prompt m1", "step m2"])
  expect(older.earlier).toBeNull()
  expect(transport.asked.filter((line) => line.includes("/message"))).toHaveLength(5)
})

const SESSION = {
  id: "s",
  projectID: "p",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  location: { directory: "/work" },
}

test("an earlier session goes on in place, and a copy before a prompt goes on as its own session", async () => {
  const { events, outputs, transport } = await replayAgent((driver) => fork.run(driver), fixture("fork"))
  expect(transport.unused()).toEqual([])
  const starts = events.flatMap((event, index) => (event.type === "ready" ? [index] : []))
  expect(starts).toHaveLength(3)
  // The resumed session's resync after the reconnect tells nothing it stored before.
  const resumed = events.slice(starts[1], starts[2])
  expect(said(resumed)).toEqual(["FOXTROT three", "Three done."])
  const copied = events.slice(starts[2])
  expect(copied.find((event) => event.type === "title")).toMatchObject({ title: "Counting turns (fork #1)" })
  const history = pages(outputs).at(-1)
  expect(said(history?.events ?? [])).toEqual(["FOXTROT one", "One done.", "FOXTROT four", "Four, on the copy."])
  expect(listed(outputs).map((entry) => entry.title)).toEqual(["Counting turns (fork #1)", "Counting turns"])
})

test("the first prompt gets opencode's title, a rename replaces it, and the list reads the new one", async () => {
  const store = createSession({ starting: true })
  const { events, outputs, transport } = await replayAgent((driver) => title.run(driver), fixture("title"), { store })
  expect(transport.unused()).toEqual([])
  expect(events.flatMap((event) => (event.type === "title" ? [event.title] : []))).toEqual([
    "Naming the session",
    "Renamed by hand",
  ])
  expect(store.state.agentTitle).toBe("Renamed by hand")
  expect(listed(outputs).map((entry) => entry.title)).toEqual(["Renamed by hand"])
  const golden = join(ROOT, "fixtures", "goldens", "opencode", "title.json")
  const got = `${JSON.stringify({ events: events.filter((event) => event.type !== "seen"), outputs, state: store.state }, null, 2)}\n`
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") writeFileSync(golden, got)
  expect(got).toBe(readFileSync(golden, "utf8"))
})
