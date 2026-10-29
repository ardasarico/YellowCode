import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import { lists } from "../../../tools/opencode/scenarios/lists.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { readFixture } from "./fixture.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = readFixture(readFileSync(join(ROOT, "fixtures", "opencode", "lists.jsonl"), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// The golden is written again only with UPDATE_OPENCODE_GOLDENS=1.
test("the lists come on request and follow opencode's word, the server turns off and on, and the command runs", async () => {
  const store = createSession({ starting: true })
  const run = await replayAgent((driver) => lists.run(driver), fixture, { store })
  expect(run.transport.unused()).toEqual([])
  const golden = join(ROOT, "fixtures", "goldens", "opencode", "lists.json")
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state, lists: store.lists() }, null, 2)}\n`
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))

  const pushed = told(events, "lists").map((event) => event.lists)
  expect(pushed.flatMap((list) => list.mcp?.map((row) => row.state) ?? [])).toEqual([
    "connected",
    "off",
    "connecting",
    "connected",
    "connecting",
    "connected",
  ])
  const { commands, skills, mcp, plugins } = store.lists()
  expect(commands?.map((row) => row.name)).toContain("hello")
  expect(skills?.find((row) => row.name === "greet")?.group).toBe("project")
  expect(skills?.find((row) => row.id === "opencode")?.group).toBe("builtin")
  expect(mcp?.map((row) => [row.name, row.state, row.tools])).toEqual([["echo", "connected", null]])
  // opencode's own plugins are left out.
  expect(plugins).toEqual([])
  const files = run.outputs.flatMap((output) => ("files" in output ? output.files : []))
  expect(files).toContain("README.md")

  // The command goes out by name, and its message, made from the template, shows as typed under our prompt.
  const sent = fixture.lines.flatMap((line) =>
    line.kind === "http" && line.method === "POST" && line.path.endsWith("/command") ? [line.body] : [],
  )
  expect(sent).toEqual([{ name: "hello", text: "the team", delivery: "steer" }])
  const user = told(events, "user")
  expect(user.map((event) => [event.prompt, event.text])).toEqual([["prompt-1", "/hello the team"]])
  expect(told(events, "user.taken").map((event) => event.prompts)).toEqual([["prompt-1"]])
  expect(told(events, "turn.end")).toHaveLength(1)
})

test("a skill's text and a server's error stay out of the recording", () => {
  const text = readFileSync(join(ROOT, "fixtures", "opencode", "lists.jsonl"), "utf8")
  expect(text).not.toContain('"content"')
  expect(text).not.toContain('"error":')
})
