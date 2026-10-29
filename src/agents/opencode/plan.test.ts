import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import { pick } from "../../../tools/opencode/driver.ts"
import type { AgentScenario } from "../../../tools/opencode/scenario.ts"
import { PLAN_DONE, planFile, planQuestion } from "../../../tools/opencode/scenarios/plan.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { readFixture, type HttpLine } from "./fixture.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${name}.jsonl`), "utf8"))
const PLAN_PATH = "<root>/home/.opencode/plan/report-json.md"

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
  const run = await replayAgent((driver) => scenario.run(driver), fixture(scenario.name), {
    store,
    files: { [PLAN_PATH]: PLAN_DONE },
  })
  expect(run.transport.unused()).toEqual([])
  const golden = join(ROOT, "fixtures", "goldens", "opencode", `${scenario.name}.json`)
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state }, null, 2)}\n`
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))
  return { events, store }
}

test("a plan file written in plan mode ends the turn with the plan, and starting on it switches before it sends", async () => {
  const { events, store } = await replayed(planFile)
  expect(told(events, "lists")[0]?.lists.modes?.map((mode) => [mode.id, mode.kind])).toEqual([
    ["build", "auto"],
    ["plan", "plan"],
  ])
  expect(told(events, "mode").map((event) => event.mode)).toEqual(["build", "plan", "build"])
  expect(told(events, "plan")).toMatchObject([{ text: PLAN_DONE, path: PLAN_PATH, next: "build" }])
  expect(events[events.findIndex((event) => event.type === "turn.end") + 1]?.type).toBe("plan")
  // The band waits in the store; the app answers it.
  const asks = store.state.items.flatMap((id) => {
    const item = store.state.byId[id]
    return item?.kind === "ask" ? [item] : []
  })
  expect(asks).toMatchObject([{ toolKind: "plan", ownPlan: { next: "build" }, status: "pending" }])

  // The switch went out before the start message, and the start message ran in build.
  const http = fixture("plan-file").lines.filter((line): line is HttpLine => line.kind === "http")
  const switched = http.findIndex((line) => line.path.endsWith("/agent") && pick(line.body, "agent") === "build")
  const started = http.findIndex(
    (line) => line.path.endsWith("/prompt") && pick(line.body, "text") === "Implement the plan.",
  )
  expect(switched).toBeGreaterThan(-1)
  expect(started).toBeGreaterThan(switched)
  const steps = fixture("plan-file").lines.flatMap((line) =>
    line.kind === "sse" && pick(line.event, "type") === "session.step.started"
      ? [pick(line.event, "data", "agent")]
      : [],
  )
  expect(steps).toEqual(["plan", "plan", "plan", "build"])
  expect(told(events, "text.end").at(-1)?.text).toBe("Implementing it now.")
})

test("a plan-mode turn without a plan file, and a plan-folder write in build, give no plan", async () => {
  const { events, store } = await replayed(planQuestion)
  expect(told(events, "plan")).toEqual([])
  expect(told(events, "mode").map((event) => event.mode)).toEqual(["build", "plan", "build"])
  expect(told(events, "tool.end").map((event) => event.status)).toEqual(["done", "error", "done"])
  expect(store.state.items.some((id) => store.state.byId[id]?.kind === "ask")).toBe(false)
})
