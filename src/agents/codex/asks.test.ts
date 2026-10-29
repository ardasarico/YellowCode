import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/codex/agent-driver.ts"
import type { AgentScenario } from "../../../tools/codex/scenario.ts"
import {
  elicitation,
  modTool,
  nativeQuestion,
  ownAsk,
  patchApproval,
  permissions,
} from "../../../tools/codex/scenarios/asks.ts"
import { modServers } from "../../../tools/codex/scenarios/mods.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { createAsks } from "./asks.ts"
import { readFixture } from "./fixture.ts"
import type { Rpc } from "./transport.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const PROJECT = "<root>/project"
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "codex", `${name}.jsonl`), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// The replay checks every answer we sent against the recorded one, so a wrong decision object fails here.
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
  return { events, store }
}

const asked = (events: AgentEvent[]) => told(events, "ask.open").map((open) => open.ask)
const outcomes = (events: AgentEvent[]) => told(events, "ask.close").map((close) => close.outcome.status)
const options = (events: AgentEvent[]) =>
  asked(events).map((ask) => ask.options.map((option) => [option.id, option.effect, option.lasts, option.subject]))

test("a command asks with Codex's own answers and one no; a permission request asks for the turn or the session", async () => {
  const { events } = await replayed(permissions)
  // The third touch ran under the rule the second answer added, so it did not ask.
  expect(options(events)).toEqual([
    [
      ["accept", "allow", "once", null],
      ["execpolicy", "allow", "everywhere", "touch"],
      ["decline", "deny", "once", null],
    ],
    [
      ["accept", "allow", "once", null],
      ["execpolicy", "allow", "everywhere", "touch"],
      ["decline", "deny", "once", null],
    ],
    [
      ["accept", "allow", "once", null],
      ["execpolicy", "allow", "everywhere", "mkdir"],
      ["decline", "deny", "once", null],
    ],
    [
      ["turn", "allow", "turn", "network access"],
      ["session", "allow", "session", "network access"],
      ["decline", "deny", "once", null],
    ],
  ])
  const [first] = asked(events)
  expect(first).toMatchObject({ kind: "permission", call: "call_mock0001", target: "touch one.txt" })
  expect(first?.detail).toBe("Make the first file")
  expect(outcomes(events)).toEqual(["allowed", "allowed", "denied", "allowed"])
  expect(told(events, "tool.end").map((end) => [end.status, end.outcome?.status ?? null])).toEqual([
    ["done", null],
    ["done", null],
    ["done", null],
    ["error", "denied"],
  ])
})

test("a patch asks with its diff and the files it writes, which rewind reads first", async () => {
  const { events } = await replayed(patchApproval)
  const asks = asked(events)
  expect(asks.map((ask) => [ask.tool.kind, ask.writes])).toEqual([
    ["edit", [`${PROJECT}/notes.md`, `${PROJECT}/src/a.ts`]],
    ["delete", [`${PROJECT}/README.md`]],
    ["write", [`${PROJECT}/two.md`]],
  ])
  expect(asks[0]?.preview).toEqual({
    type: "diff",
    files: [
      {
        path: `${PROJECT}/notes.md`,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+# Notes"] }],
      },
      {
        path: `${PROJECT}/src/a.ts`,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-export const greeting = "hello"', '+export const greeting = "hello, world"'],
          },
        ],
      },
    ],
  })
  expect(asks[2]?.options.map((option) => [option.id, option.lasts, option.subject])).toEqual([
    ["accept", "once", null],
    ["acceptForSession", "session", `${PROJECT}/two.md`],
    ["decline", "once", null],
  ])
  expect(outcomes(events)).toEqual(["allowed", "denied", "allowed"])
  expect(told(events, "tool.end").map((end) => end.status)).toEqual(["done", "error", "done", "done"])
})

test("our own ask opens on its row, and each way it ends reaches the model", async () => {
  const { events, store } = await replayed(ownAsk)
  const asks = asked(events)
  expect(asks.map((ask) => [ask.call, ask.own])).toEqual([
    ["call_mock0001", { handle: 0 }],
    ["call_mock0002", { handle: 1 }],
  ])
  expect(asks[0]?.questions).toMatchObject({ pages: [{ key: "Which color?", header: "Color" }] })
  expect(told(events, "ask.close").map((close) => close.outcome)).toMatchObject([
    { status: "answered", answers: { "Which color?": "Blue" }, notes: {} },
    { status: "denied", why: "chat" },
  ])
  // The broken one is turned down unseen; its row says why.
  expect(told(events, "tool.end").map((end) => end.outcome?.status === "denied" && end.outcome.why)).toEqual([
    false,
    "chat",
    "unshown",
  ])
  expect(told(events, "tool.start").map((start) => [start.kind, start.title])).toEqual([
    ["question", "ask"],
    ["question", "ask"],
    ["question", "ask"],
  ])
  expect(store.state.items.filter((id) => store.state.byId[id]?.kind === "ask")).toHaveLength(2)
})

test("Codex's own questions are pages by question id that take typed answers", async () => {
  const { events } = await replayed(nativeQuestion)
  const [ask] = asked(events)
  const pages = ask?.questions && "pages" in ask.questions ? ask.questions.pages : []
  expect(pages.map((page) => [page.key, page.header, page.custom, page.options.map((option) => option.label)])).toEqual(
    [
      ["color", "Color", true, ["Blue (Recommended)", "Green"]],
      ["size", "Size", true, ["Small", "Large"]],
    ],
  )
  expect(told(events, "ask.close").map((close) => close.outcome)).toEqual([
    { status: "answered", answers: { color: "Green", size: "Medium" }, notes: {} },
    { status: "denied", said: "", why: "declined", note: "" },
  ])
})

test("an MCP tool's approval is a permission on its call, and its server's form is a page", async () => {
  const { events } = await replayed(elicitation)
  const [approval, form] = asked(events)
  expect(approval).toMatchObject({
    kind: "permission",
    call: "call_mock0002",
    tool: { name: "pick", kind: "mcp", mcp: { server: "ask", tool: "pick" } },
    detail: "Asks the user for a color",
  })
  expect(approval?.options.map((option) => [option.id, option.lasts])).toEqual([
    ["accept", "once"],
    ["session", "session"],
    ["always", "kept"],
    ["decline", "once"],
  ])
  expect(form?.questions).toMatchObject({
    pages: [{ key: "color", header: "Color", options: [{ label: "Blue" }, { label: "Green" }] }],
  })
  // The session's yes held, so the second call asked nothing but its form.
  expect(told(events, "ask.close").map((close) => close.outcome)).toEqual([
    { status: "allowed" },
    { status: "answered", answers: { color: "blue" }, notes: {} },
    { status: "denied", said: "", why: "declined", note: "" },
  ])
  expect(told(events, "tool.end").map((end) => end.result)).toEqual(['accept: {"color":"blue"}', "decline: null"])
})

test("a mod's tool runs under its namespace, also after a resume in a new app-server", async () => {
  const { events } = await replayed(modTool)
  expect(told(events, "tool.start").map((start) => [start.kind, start.mcp])).toEqual([
    ["mcp", { server: "mod-demo", tool: "echo" }],
    ["mcp", { server: "mod-demo", tool: "echo" }],
  ])
  expect(told(events, "tool.end").map((end) => [end.status, end.result])).toEqual([
    ["done", "echo: hi"],
    ["done", "echo: again"],
  ])
})

test("a mod's manifest server starts with the thread and with its resume, and its tool asks first", async () => {
  const { events } = await replayed(modServers)
  expect(told(events, "tool.start").map((start) => [start.kind, start.mcp])).toEqual([
    ["mcp", { server: "mod-demo--echo", tool: "echo" }],
  ])
  expect(outcomes(events)).toEqual(["allowed"])
  expect(told(events, "tool.end").map((end) => [end.status, end.result])).toEqual([["done", "echo: from the mod"]])
})

// A stand-in for app-server's side of the requests.
function fakeRpc() {
  const sent: unknown[] = []
  const rpc: Rpc = {
    request: () => Promise.resolve(null),
    notify: () => {},
    respond: (id, result) => sent.push({ id, result }),
    fail: (id, code) => sent.push({ id, code }),
    incoming: (async function* () {})(),
    exited: new Promise(() => {}),
    close: () => Promise.resolve(),
  }
  return { rpc, sent }
}

function asksOf() {
  const events: AgentEvent[] = []
  const asks = createAsks({
    thread: "t1",
    cwd: PROJECT,
    lookup: { item: () => null, subagent: () => null, mcpCall: () => null },
    tools: () => [],
    tell: (more) => events.push(...more),
    at: () => 5,
  })
  return { asks, events }
}

const question = (isSecret: boolean) => ({
  id: isSecret ? "key" : "color",
  header: isSecret ? "API key" : "Color",
  question: isSecret ? "Paste your key" : "Which color?",
  isOther: isSecret,
  isSecret,
  options: isSecret ? null : [{ label: "Blue", description: "Calm" }],
})

test("a question marked secret is turned down with a notice and never reaches the store", () => {
  const { asks, events } = asksOf()
  const { rpc, sent } = fakeRpc()
  const params = { threadId: "t1", turnId: "u1", itemId: "c1", questions: [question(false), question(true)] }
  asks.request(rpc, 7, "item/tool/requestUserInput", params)
  expect(sent).toEqual([{ id: 7, result: { answers: {} } }])
  expect(events.map((event) => event.type)).toEqual(["notice"])
  const store = createSession({ starting: true })
  for (const event of events) store.event(event)
  expect(JSON.stringify(store.state)).not.toContain("Paste your key")
  expect(store.state.items.some((id) => store.state.byId[id]?.kind === "ask")).toBe(false)
})

const approval = (itemId: string) => ({ threadId: "t1", turnId: "u1", itemId, command: "ls" })

test("an ask Codex stops waiting for closes as cancelled, and so does one an app-server took with it", () => {
  const { asks, events } = asksOf()
  const { rpc, sent } = fakeRpc()
  asks.request(rpc, 1, "item/commandExecution/requestApproval", approval("c1"))
  asks.request(rpc, 2, "item/commandExecution/requestApproval", approval("c2"))
  asks.resolved(rpc, 1)
  asks.gone()
  expect(told(events, "ask.close").map((close) => [close.id, close.outcome.status])).toEqual([
    ["codex-1", "cancelled"],
    ["codex-2", "cancelled"],
  ])
  // Without a list, a command offers a yes, a yes for the session and the no.
  expect(asked(events)[0]?.options.map((option) => option.id)).toEqual(["accept", "acceptForSession", "decline"])
  expect(sent).toEqual([])
})

test("a network rule is an option of its own, and its answer goes back as Codex gave it", () => {
  const { asks, events } = asksOf()
  const { rpc, sent } = fakeRpc()
  const amendment = {
    applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } },
  }
  asks.request(rpc, 3, "item/commandExecution/requestApproval", {
    threadId: "t1",
    turnId: "u1",
    itemId: "c1",
    command: "curl example.com",
    availableDecisions: ["accept", "acceptForSession", amendment, "decline", "cancel"],
  })
  const [ask] = asked(events)
  expect(ask?.options.map((option) => [option.id, option.lasts, option.label])).toEqual([
    ["accept", "once", null],
    ["acceptForSession", "session", null],
    ["network-0", "everywhere", "Yes, and always allow connections to example.com"],
    ["decline", "once", null],
  ])
  asks.answer(ask?.id ?? "", { type: "option", option: "network-0", note: null })
  expect(sent).toEqual([{ id: 3, result: { decision: amendment } }])
})

test("a request YellowCode does not know gets an error", () => {
  const { asks } = asksOf()
  const { rpc, sent } = fakeRpc()
  asks.request(rpc, 9, "account/chatgptAuthTokens/refresh", {})
  expect(sent).toEqual([{ id: 9, code: -32601 }])
})
