import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/codex/agent-driver.ts"
import type { AgentScenario } from "../../../tools/codex/scenario.ts"
import { models, modes, plan, planSteps } from "../../../tools/codex/scenarios/modes.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { nextMode } from "../../session/settings.ts"
import { todoList } from "../../session/todos.ts"
import { allowedConfig } from "./allow.ts"
import { readFixture } from "./fixture.ts"
import { accessOf, modeRows } from "./modes.ts"
import { createTranslator } from "./translate.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "codex", `${name}.jsonl`), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// The replay checks every request we sent against the recorded one, so a wrong settings update fails here.
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

test("the modes walk as Shift+Tab does, Plan keeps the access, and a resumed thread switches to the mode asked for", async () => {
  const { events, store } = await replayed(modes)
  const rows = told(events, "lists")[0]?.lists.modes ?? []
  expect(rows.map((row) => [row.id, row.kind, row.cycle])).toEqual([
    ["read-only", "readonly", true],
    ["auto", "auto", true],
    ["plan", "plan", true],
    ["full-access", "bypass", false],
  ])
  expect(told(events, "mode").map((event) => event.mode)).toEqual([
    "read-only",
    "auto",
    "plan",
    "full-access",
    "read-only",
  ])
  expect([
    nextMode(rows, "read-only"),
    nextMode(rows, "auto"),
    nextMode(rows, "plan"),
    nextMode(rows, "full-access"),
  ]).toEqual(["auto", "plan", "read-only", "read-only"])
  expect(store.state.permissionMode).toBe("read-only")
})

test("models list in the session's provider's group and another's, and switches go out between turns", async () => {
  const { events } = await replayed(models)
  const groups = told(events, "lists")[0]?.lists.models ?? []
  expect(groups.map((group) => [group.provider?.name, group.applies])).toEqual([
    ["Mock", "now"],
    ["Other", "new-session"],
  ])
  const luna = groups[0]?.models.find((row) => row.ref.id === "gpt-5.6-luna")
  expect(luna?.efforts.map((row) => [row.id, row.note ?? ""])).toEqual([
    ["low", ""],
    ["medium", "default"],
    ["high", ""],
    ["xhigh", ""],
    ["max", ""],
  ])
  expect(luna?.images).toBe(true)
  expect(told(events, "model").map((event) => event.model?.id)).toEqual(["gpt-5.5", "gpt-5.6-luna"])
  // gpt-5.5's default, then luna's, then the picks.
  expect(told(events, "effort").map((event) => event.effort)).toEqual(["medium", "high", "low"])
})

test("a finished plan opens the band once its turn ends, and goes on in the access it was made in", async () => {
  const { events, store } = await replayed(plan)
  expect(told(events, "plan").map((event) => [event.text, event.path, event.next])).toEqual([
    ["# Greeting\n\n1. Read src/a.ts\n2. Change the greeting\n", null, "auto"],
  ])
  const order = events.map((event) => event.type).filter((type) => type === "turn.end" || type === "plan")
  expect(order).toEqual(["turn.end", "plan", "turn.end"])
  expect(told(events, "mode").map((event) => event.mode)).toEqual(["plan", "auto"])
  expect(told(events, "text.start").filter((event) => event.text.startsWith("# Greeting"))).toHaveLength(1)
  expect(store.state.items.some((id) => store.state.byId[id]?.kind === "ask")).toBe(true)
})

test("plan steps are the session's todo list, each update the whole list", async () => {
  const { events, store } = await replayed(planSteps)
  expect(told(events, "todos").map((event) => event.items.map((item) => item.state))).toEqual([
    ["running", "pending"],
    ["done", "done"],
  ])
  expect(todoList(store.state)).toEqual([
    { id: "1", text: "Read src/a.ts", state: "done" },
    { id: "2", text: "Change the greeting", state: "done" },
  ])
})

test("profiles of the user's own follow the presets and are picked, not walked", () => {
  const rows = modeRows(false, [
    { id: ":read-only", allowed: true },
    { id: "work", description: "Work tree", allowed: false },
  ])
  expect(rows.map((row) => [row.id, row.cycle, row.available])).toEqual([
    ["read-only", true, true],
    ["auto", true, true],
    ["full-access", false, true],
    ["profile:work", false, false],
  ])
  expect(accessOf("on-request", { type: "readOnly" }, ":read-only")).toBe("read-only")
  expect(accessOf("on-request", { type: "workspaceWrite" }, "work")).toBe("profile:work")
  expect(accessOf("untrusted", { type: "readOnly" }, null)).toBe("untrusted readOnly")
})

test("config/read keeps each provider's name and nothing else", () => {
  const reply = {
    config: {
      model: "gpt-5.5",
      mcp_servers: { s: { env: { KEY: "v" } } },
      model_providers: {
        mock: { name: "Mock", base_url: "http://x", http_headers: { Authorization: "Bearer y" }, env_key: "K" },
        bare: { base_url: "http://z" },
      },
    },
  }
  expect(allowedConfig(reply).config).toEqual({ model_providers: { mock: { name: "Mock" }, bare: {} } })
  expect(allowedConfig("nonsense")).toEqual({ config: { model_providers: {} }, origins: {}, layers: null })
})

test("a stored plan reads back as text, with no band", () => {
  const translator = createTranslator("thread")
  const item = { type: "plan", id: "turn-plan", text: "# Plan\n\n1. One\n" } as const
  const turn = { id: "turn", items: [item], status: "completed", startedAt: 1 }
  expect(translator.readBack([turn]).map((event) => [event.type, "text" in event ? event.text : null])).toEqual([
    ["text.start", "# Plan\n\n1. One\n"],
    ["text.end", null],
  ])
})
