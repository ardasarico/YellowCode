import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import { permissions } from "../../../tools/opencode/scenarios/permissions.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { choiceOf } from "../../ui/ask/permission-band.tsx"
import { permissionAsk } from "./asks.ts"
import { readFixture } from "./fixture.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const PROJECT = "<root>/project"
const fixture = readFixture(readFileSync(join(ROOT, "fixtures", "opencode", "permissions.jsonl"), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// The golden is written again only with UPDATE_OPENCODE_GOLDENS=1.
test("each answer reaches opencode: once, always, a no with a note and one without, and another client's", async () => {
  const store = createSession({ starting: true })
  const run = await replayAgent((driver) => permissions.run(driver), fixture, { store })
  expect(run.transport.unused()).toEqual([])
  const golden = join(ROOT, "fixtures", "goldens", "opencode", "permissions.json")
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state }, null, 2)}\n`
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))

  const asks = told(events, "ask.open").map(({ ask }) => [ask.title, ask.target, ask.call, ask.writes])
  expect(asks).toEqual([
    ["shell", "ls", "toolu_mock0001", []],
    ["shell", "git status", "toolu_mock0002", []],
    ["edit", "src/a.ts", "toolu_mock0004", [`${PROJECT}/src/a.ts`]],
    ["write", "src/b.ts", "toolu_mock0005", [`${PROJECT}/src/b.ts`]],
    ["shell", "echo hi", "toolu_mock0006", []],
    ["shell", "pwd", "toolu_mock0007", []],
  ])
  // The command allowed always runs again without asking.
  expect(told(events, "tool.called").filter((call) => call.summary === "git status")).toHaveLength(2)
  const replies = fixture.lines.flatMap((line) =>
    line.kind === "http" && line.path.endsWith("/reply") ? [line.body] : [],
  )
  expect(replies).toEqual([
    { decision: "once" },
    { decision: "always" },
    { decision: "reject", message: "Keep the greeting as it is." },
    { decision: "once" },
    { decision: "reject" },
    { decision: "once" },
  ])
  expect(told(events, "ask.close").map((close) => close.outcome)).toEqual([
    { status: "allowed" },
    { status: "allowed" },
    { status: "denied", said: "Keep the greeting as it is.", why: "declined", note: "Keep the greeting as it is." },
    { status: "allowed" },
    { status: "denied", said: "", why: "declined", note: "" },
    { status: "allowed" },
  ])
  // A no with a note lets the turn go on; one without stops it.
  expect(told(events, "turn.end").map((end) => end.interrupted)).toEqual([false, true, false])
  expect(told(events, "text.end").map((end) => end.text)).toContain("The tour is done.")
  const rules = told(events, "lists").flatMap(({ lists }) =>
    lists.rules ? [lists.rules.map((rule) => [rule.subject, rule.pattern])] : [],
  )
  expect(rules.at(0)).toEqual([])
  expect(rules).toContainEqual([["shell", "git status *"]])
  expect(rules.at(-1)).toEqual([])
})

test("the band reads opencode's options as one yes, a lasting yes for the saved patterns, and one no with a note", () => {
  const request = {
    id: "per_1",
    sessionID: "ses_1",
    action: "shell",
    resources: ["git status", "ls"],
    save: ["git status *", "ls *"],
  }
  const { options } = permissionAsk(request, { call: null, tool: null, by: null, directory: PROJECT })
  const words = options.map(choiceOf).map((choice) => `${choice.before}${choice.subject}${choice.after}`)
  expect(words).toEqual(["Yes", "Yes, and always allow git status *, ls * here", "No"])
  expect(options.map((option) => [option.id, option.note, option.endsTurn])).toEqual([
    ["once", false, false],
    ["always", false, false],
    ["reject", true, false],
  ])
})
