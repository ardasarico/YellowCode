import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent, type DriverOutput } from "../../../tools/codex/agent-driver.ts"
import type { AgentScenario } from "../../../tools/codex/scenario.ts"
import { text } from "../../../tools/codex/scenarios/turns.ts"
import { compact, limits, title, usage } from "../../../tools/codex/scenarios/usage.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { readFixture, type Fixture, type FixtureLine } from "./fixture.ts"
import { limitsOf } from "./usage.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "codex", `${name}.jsonl`), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// Replays the scenario into a store and checks it against its golden, written again only with
// UPDATE_CODEX_GOLDENS=1.
async function replayed(scenario: AgentScenario, recorded = fixture(scenario.name), name = scenario.name) {
  const store = createSession({ starting: true })
  const run = await replayAgent((driver) => scenario.run(driver), recorded, { store })
  expect(run.transports.map((transport) => transport.unused())).toEqual(run.transports.map(() => []))
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state }, null, 2)}\n`
  const golden = join(ROOT, "fixtures", "goldens", "codex", `${name}.json`)
  if (process.env["UPDATE_CODEX_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))
  return { events: run.events, outputs: run.outputs, store }
}

const reports = (outputs: DriverOutput[]) =>
  outputs.flatMap((output) => ("context" in output ? [[output.context.used, output.context.window]] : []))

test("each turn's tokens are what the thread's total grew by, and the context is the last request's", async () => {
  const { events, outputs, store } = await replayed(usage)
  expect(told(events, "turn.end").map((end) => [end.inputTokens, end.outputTokens, end.tokens])).toEqual([
    [6600, 320, 6920],
    [4000, 40, 4040],
  ])
  expect(told(events, "context.used").map((used) => used.tokens)).toEqual([3200, 3720, 4040, 4040])
  // Before the first turn Codex has said nothing of the context; a resumed thread says it at once.
  expect(reports(outputs)).toEqual([
    [0, 0],
    [3720, 258400],
    [4040, 258400],
  ])
  expect(store.state.usage.context).toEqual({ used: 4040, window: 258400 })
})

test("the account's windows come with each answer, and a refusal at the limit warns", async () => {
  const { events, store } = await replayed(limits)
  const [first, second] = told(events, "limits")
  expect(first?.windows.map((window) => [window.minutes, window.utilization])).toEqual([
    [300, 0.43],
    [10080, 1],
  ])
  expect(first?.warning).toBeNull()
  expect(second?.warning).toMatchObject({ reached: true, minutes: 10080, status: "rejected", type: "seven_day" })
  // A response that sends no limits leaves them as they were.
  expect(told(events, "limits")).toHaveLength(2)
  expect(store.state.usage.limits.week?.utilization).toBe(1)
})

test("/compact runs as a turn of its own with no row, and a full context compacts before the next prompt", async () => {
  const { events, outputs, store } = await replayed(compact)
  expect(told(events, "turn.end").map((end) => end.local)).toEqual([false, true, false, false])
  expect(told(events, "compacted").map((done) => [done.before, done.after])).toEqual([
    [1380, 7900],
    [24300, 7903],
  ])
  const shown = store.state.items.flatMap((id) => {
    const item = store.state.byId[id]
    return item?.kind === "user" ? [`user ${item.text}`] : item?.kind === "system" ? [item.text] : []
  })
  expect(shown).toEqual([
    "user QUEBEC one",
    "user /compact",
    "context compacted",
    "user QUEBEC full",
    "user QUEBEC after",
    "context compacted",
  ])
  const history = outputs.flatMap((output) => ("history" in output ? output.history.events : []))
  expect(told(history, "compacted")).toHaveLength(2)
})

test("the titler's thread is not listed, and the title it gives names the thread", async () => {
  const { events, outputs } = await replayed(title)
  expect(outputs[0]).toEqual({ answer: "TITLE: Helper rename\nSUMMARY: renaming" })
  expect(told(events, "title").map((named) => named.title)).toEqual(["Helper rename"])
  const listed = outputs.flatMap((output) => ("sessions" in output ? output.sessions : []))
  expect(listed.map((row) => row.title)).toEqual(["Helper rename"])
  const oneShot = fixture("title").lines.find(
    (line) => line.kind === "out" && line.c === 1 && JSON.stringify(line.msg).includes('"thread/start"'),
  )
  expect(oneShot?.kind === "out" && JSON.stringify(oneShot.msg)).toContain('"ephemeral":true')
})

// A request inserted as the first app-server's message number `at`, answered with `result` right after.
function inserted(base: Fixture, at: number, method: string, result: unknown): Fixture {
  const lines: FixtureLine[] = []
  for (const line of base.lines) {
    if (line.kind === "out" && (line.c ?? 0) === 0 && line.n === at) {
      lines.push({ kind: "out", n: at, t: line.t, msg: { id: 99, method, params: {} } })
      lines.push({ kind: "in", t: line.t, after: at + 1, msg: { id: 99, result } })
    }
    if (line.kind === "out" && (line.c ?? 0) === 0 && line.n >= at) lines.push({ ...line, n: line.n + 1 })
    else if ((line.kind === "in" || line.kind === "exit") && (line.c ?? 0) === 0 && line.after > at)
      lines.push({ ...line, after: line.after + 1 })
    else lines.push(line)
  }
  return { ...base, lines }
}

const window = (usedPercent: number, windowDurationMins: number) => ({
  usedPercent,
  windowDurationMins,
  resetsAt: 1_800_000_000,
})

test("a ChatGPT sign-in reads every limit at the start", async () => {
  const signedIn = fixture("text")
  for (const line of signedIn.lines)
    if (line.kind === "in" && JSON.stringify(line.msg).includes('"requiresOpenaiAuth"'))
      line.msg = { id: 1, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } }
  const own = { limitId: "codex", limitName: null, primary: window(12, 300), secondary: window(40, 10080) }
  const spark = { limitId: "codex_spark", limitName: "GPT-5.5 Spark", primary: null, secondary: window(5, 10080) }
  const read = inserted(signedIn, 4, "account/rateLimits/read", {
    rateLimits: own,
    rateLimitsByLimitId: { codex: own, codex_spark: spark },
  })
  const run = await replayAgent((driver) => text.run(driver), read)
  expect(run.transports.map((transport) => transport.unused())).toEqual([[]])
  expect(told(run.events, "limits").map((event) => event.windows.map((row) => [row.model, row.minutes]))).toEqual([
    [
      [null, 300],
      [null, 10080],
    ],
    [["GPT-5.5 Spark", 10080]],
  ])
})

test("a limit with no windows and nothing reached tells nothing", () => {
  expect(limitsOf({ limitId: "codex", primary: null, secondary: null, rateLimitReachedType: null })).toBeNull()
  const credits = limitsOf({
    limitId: "codex",
    primary: null,
    rateLimitReachedType: "workspace_owner_credits_depleted",
  })
  expect(credits?.type === "limits" && credits.warning?.type).toBe("workspace_owner_credits_depleted")
})
