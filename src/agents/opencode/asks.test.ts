import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import type { AgentScenario } from "../../../tools/opencode/scenario.ts"
import { nativeForm, ownAsk } from "../../../tools/opencode/scenarios/asks.ts"
import { modTool } from "../../../tools/opencode/scenarios/client-tools.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { QUESTION_TO_CHAT, SUBAGENT_ASK } from "../../protocol/outgoing.ts"
import { createSession } from "../../session/session.ts"
import { formAsk, formReply } from "./asks.ts"
import { readFixture, type HttpLine } from "./fixture.ts"
import { ELSEWHERE, NOT_OURS, type OwnMcpDeps, startOwnMcp } from "./own-mcp.ts"
import { realClock } from "./sse.ts"
import { channel, type Socket, type Transport } from "./transport.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${name}.jsonl`), "utf8"))

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
  return { ...run, events }
}

const toolResult = z.looseObject({
  result: z.looseObject({ content: z.array(z.looseObject({ text: z.string() })), isError: z.boolean().optional() }),
})

// The text and error flag of each call result our server sent.
const results = (name: string) =>
  fixture(name).lines.flatMap((line) => {
    const result = line.kind === "ws" && line.dir === "out" ? toolResult.safeParse(line.frame).data?.result : undefined
    return result ? [[result.content[0]?.text ?? "", result.isError ?? false]] : []
  })

test("our own ask opens for the main session only, and its answer, a no and a cancel go back as the call's result", async () => {
  const { events } = await replayed(ownAsk)
  const created = fixture("own-ask").lines.find(
    (line): line is HttpLine => line.kind === "http" && line.method === "POST" && line.path === "/api/session",
  )
  expect(created?.body).toMatchObject({ permissions: [{ action: "question", resource: "*", effect: "deny" }] })
  const opened = told(events, "ask.open").map(({ ask }) => [
    ask.tool.name,
    ask.own,
    ask.questions && Object.keys(ask.questions),
  ])
  expect(opened).toEqual([
    ["yellowcode.ask", { handle: 2 }, ["pages"]],
    ["yellowcode.ask", { handle: 3 }, ["matrix"]],
    ["yellowcode.ask", { handle: 5 }, ["pages"]],
  ])
  expect(told(events, "ask.close").map((close) => close.outcome)).toEqual([
    {
      status: "answered",
      answers: { "Which color?": "Blue", "Which sizes?": "S, L" },
      notes: { "Which color?": "Dark", "Which sizes?": "Additional note: Thanks" },
    },
    {
      status: "denied",
      said: QUESTION_TO_CHAT,
      why: "chat",
      note: "",
    },
    { status: "cancelled" },
  ])
  // The subagent's call and the other session's are turned down unseen.
  expect(results("own-ask")).toEqual([
    [
      'Your questions have been answered: "Which color?"="Blue" notes: Dark, "Which sizes?"="S, L" notes: ' +
        "Additional note: Thanks. You can now continue with these answers in mind.",
      false,
    ],
    [QUESTION_TO_CHAT, true],
    [SUBAGENT_ASK, true],
    [ELSEWHERE, true],
  ])
  expect(told(events, "turn.end").map((end) => end.interrupted)).toEqual([false, false, false, false, true, false])
})

test("opencode's own question form opens as pages, answered by field key, typed, or dismissed, which ends the turn", async () => {
  const { events } = await replayed(nativeForm)
  const pages = told(events, "ask.open").map(({ ask }) =>
    ask.questions && "pages" in ask.questions ? ask.questions.pages.map((page) => [page.key, page.multi]) : null,
  )
  expect(pages).toEqual([
    [
      ["q0", false],
      ["q1", true],
    ],
    [["q0", false]],
    [
      ["q0", false],
      ["q1", true],
    ],
  ])
  const sent = fixture("native-form").lines.flatMap((line) =>
    line.kind === "http" && line.path.includes("/form/") ? [[line.method, line.body]] : [],
  )
  expect(sent).toEqual([
    ["POST", { answer: { q0: "Blue", q1: ["S", "L"] } }],
    ["POST", { answer: { q0: "Teal" } }],
    ["DELETE", undefined],
  ])
  // The first form was answered while the stream was down; the resync reads its answers from the stored call.
  expect(told(events, "ask.close").map((close) => close.outcome)).toEqual([
    { status: "answered", answers: { q0: "Blue", q1: "S, L" }, notes: {} },
    { status: "answered", answers: { q0: "Teal" }, notes: {} },
    { status: "cancelled" },
  ])
  expect(told(events, "turn.end").map((end) => end.interrupted)).toEqual([false, false, true, false])
  const patched = fixture("native-form").lines.flatMap((line) =>
    line.kind === "http" && line.method === "PATCH" ? [line.body] : [],
  )
  // The scenario takes the rule off, the session opened again gets it back, and leaving takes it off.
  expect(patched).toEqual([
    { permissions: [] },
    { permissions: [{ action: "question", resource: "*", effect: "deny" }] },
    { permissions: [] },
  ])
})

// The frames our server sent on a socket of the fixture, and the tool lists among them.
const sentOn = (name: string, socket: string) =>
  fixture(name).lines.flatMap((line) =>
    line.kind === "ws" && line.socket === socket && line.dir === "out" ? [line.frame] : [],
  )
const toolList = z.looseObject({ result: z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })) }) })
const listedOn = (name: string, socket: string) =>
  sentOn(name, socket).flatMap((frame) => {
    const parsed = toolList.safeParse(frame).data
    return parsed ? [parsed.result.tools.map((tool) => tool.name)] : []
  })

test("client tools are served one socket per server, follow each change, and run for our session only", async () => {
  await replayed(modTool)
  expect(listedOn("mod-tool", "mod-demo")).toEqual([
    ["echo", "broken"],
    ["echo", "broken", "shout"],
  ])
  expect(listedOn("mod-tool", "mod-other")).toEqual([["count"]])
  expect(sentOn("mod-tool", "mod-demo")).toContainEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
  expect(results("mod-tool")).toEqual([
    ["echo hi", false],
    ["HEY", false],
    ["3", false],
    ["no luck", true],
    [NOT_OURS, true],
  ])
})

test("a form with no field a page fits, or a required one it cannot fit, offers only a no; a choice goes back as the option's value", () => {
  const form = {
    id: "frm_1",
    sessionID: "ses_1",
    title: "Sign in",
    fields: [
      { key: "port", type: "number" as const },
      { key: "site", type: "external" as const, url: "https://example.com" },
    ],
  }
  expect(formAsk(form).options.map((option) => [option.id, option.effect])).toEqual([["dismiss", "deny"]])
  const confirm = {
    ...form,
    fields: [
      { key: "env", type: "string" as const, options: [{ value: "prod" }] },
      { key: "sure", type: "boolean" as const, required: true },
    ],
  }
  expect(formAsk(confirm).options.map((option) => option.id)).toEqual(["dismiss"])
  const picked = {
    ...form,
    fields: [{ key: "env", type: "string" as const, options: [{ value: "prod", label: "Production" }] }],
  }
  const reply = {
    type: "answers" as const,
    answers: { values: { env: ["Production"] }, fields: {}, notes: {}, note: "" },
  }
  expect(formReply(picked, reply)).toEqual({ answer: { env: "prod" } })
})

// Sockets that fail to open until the test gives one.
function sockets() {
  let ready: (Socket & { push(frame: unknown): void; sent: unknown[] }) | null = null
  const state = {
    opened: 0,
    transport: {
      request: () => Promise.reject(new Error("no requests")),
      events: () => channel<unknown>(),
      socket() {
        state.opened += 1
        const socket = ready
        ready = null
        return socket ? Promise.resolve(socket) : Promise.reject(new Error("no socket"))
      },
    } satisfies Transport,
    give() {
      const frames = channel<unknown>()
      const sent: unknown[] = []
      const socket = {
        frames,
        sent,
        send: (frame: unknown) => sent.push(frame),
        close: () => frames.end(),
        push: (frame: unknown) => frames.push(frame),
      }
      ready = socket
      return socket
    },
  }
  return state
}

function own(
  fake: ReturnType<typeof sockets>,
  heard: AgentEvent[] = [],
  session = "ses_1",
  relay: OwnMcpDeps["relay"] = () => Promise.resolve(null),
) {
  return startOwnMcp({
    transport: () => fake.transport,
    clock: realClock,
    session: () => session,
    subagent: () => Promise.resolve(false),
    relay,
    down: () => false,
    version: "0",
    tell: (events) => heard.push(...events),
    at: () => 0,
  })
}

test("a socket that does not open waits for the event stream to connect again", async () => {
  const fake = sockets()
  const server = own(fake)
  await server.attached()
  await Bun.sleep(20)
  expect(fake.opened).toBe(1)
  fake.give()
  server.wake()
  await Bun.sleep(20)
  expect(fake.opened).toBe(2)
  server.close()
})

test("an ask whose socket closes is cancelled, and the socket opens again", async () => {
  const fake = sockets()
  const socket = fake.give()
  const heard: AgentEvent[] = []
  const server = own(fake, heard)
  socket.push({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  const input = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] }
  socket.push({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask", arguments: input } })
  await Bun.sleep(20)
  expect(heard.map((event) => event.type)).toEqual(["ask.open"])
  fake.give()
  socket.close()
  await Bun.sleep(600)
  expect(heard.at(-1)).toMatchObject({ type: "ask.close", outcome: { status: "cancelled" } })
  expect(fake.opened).toBe(2)
  server.close()
})

test("a socket that listed its tools opens again after every drop, and none opens once closed", async () => {
  const fake = sockets()
  let socket = fake.give()
  const server = own(fake)
  const drop = async () => {
    socket.push({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    await Bun.sleep(20)
    const next = fake.give()
    socket.close()
    socket = next
  }
  await drop()
  await Bun.sleep(600)
  expect(fake.opened).toBe(2)
  await drop()
  await Bun.sleep(600)
  expect(fake.opened).toBe(3)
  await drop()
  await Bun.sleep(20)
  server.close()
  await Bun.sleep(600)
  expect(fake.opened).toBe(3)
})

test("a call of another YellowCode's session that opencode gave to ours is passed on, and its answer comes back", async () => {
  const theirs = sockets()
  theirs.give()
  const heard: AgentEvent[] = []
  const owner = own(theirs, heard)
  const ours = sockets()
  const socket = ours.give()
  const claimed: string[] = []
  const server = own(ours, [], "ses_2", (call, signal) => owner.take(call, signal, () => claimed.push(call.caller)))
  const input = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] }
  const meta = { "ai.opencode/sessionID": "ses_1" }
  socket.push({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask", arguments: input, _meta: meta } })
  await Bun.sleep(20)
  const opened = heard.find((event) => event.type === "ask.open")
  expect(claimed).toEqual(["ses_1"])
  if (opened?.type !== "ask.open") throw new Error("no ask")
  owner.answer(opened.ask.id, {
    type: "answers",
    answers: { values: { Pick: ["A"] }, fields: {}, notes: {}, note: "" },
  })
  await Bun.sleep(20)
  const [reply] = socket.sent
  expect(reply).toMatchObject({ jsonrpc: "2.0", id: 7 })
  expect(toolResult.parse(reply).result.isError).toBeUndefined()
  const nobody = { name: "ask", arguments: input, _meta: { "ai.opencode/sessionID": "ses_9" } }
  socket.push({ jsonrpc: "2.0", id: 8, method: "tools/call", params: nobody })
  await Bun.sleep(20)
  expect(socket.sent).toContainEqual({
    jsonrpc: "2.0",
    id: 8,
    result: { content: [{ type: "text", text: ELSEWHERE }], isError: true },
  })
  server.close()
  owner.close()
})
