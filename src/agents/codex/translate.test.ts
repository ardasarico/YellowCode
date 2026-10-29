import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/codex/agent-driver.ts"
import { pick } from "../../../tools/codex/driver.ts"
import type { AgentScenario } from "../../../tools/codex/scenario.ts"
import { mcp, subagent, tools } from "../../../tools/codex/scenarios/tools.ts"
import { error, reasoning, text, twoTurns } from "../../../tools/codex/scenarios/turns.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { rewindPoints } from "../../session/rewind.ts"
import { createSession } from "../../session/session.ts"
import { readFixture } from "./fixture.ts"
import { createTranslator } from "./translate.ts"

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

// Replays the scenario into a store and checks it against its golden, written again only with
// UPDATE_CODEX_GOLDENS=1.
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
  const history = run.outputs.flatMap((output) => ("history" in output ? output.history.events : []))
  return { events: run.events, store, history }
}

const shape = (end: Extract<AgentEvent, { type: "tool.end" }>) => [end.id, end.status, end.files, end.exitCode]

const summaries = (name: string) =>
  fixture(name).lines.flatMap((line) =>
    line.kind === "out" && pick(line.msg, "method") === "turn/start" ? [pick(line.msg, "params", "summary")] : [],
  )

test("a prompt's image goes as a data url and comes back with its echo", async () => {
  const { events } = await replayed(text)
  const [prompt] = told(events, "user")
  expect(prompt?.prompt).toBe("prompt-1")
  expect(prompt?.images.map((image) => [image.mediaType, image.data?.slice(0, 5), image.path])).toEqual([
    ["image/png", "iVBOR", null],
  ])
  const streamed = told(events, "text.delta").map((delta) => delta.text)
  expect(streamed.join("")).toBe(told(events, "text.end")[0]?.text ?? "")
  expect(summaries("text")).toEqual(["none"])
})

test("each prompt opens a turn of its own", async () => {
  const { events } = await replayed(twoTurns)
  expect(told(events, "user").map((user) => [user.prompt, user.cutPoint])).toEqual([
    ["prompt-1", true],
    ["prompt-2", true],
  ])
  expect(told(events, "turn.end").map((end) => end.error)).toEqual([null, null])
})

test("with thinking on, the reasoning summary streams as thinking before the answer", async () => {
  const { events } = await replayed(reasoning)
  expect(summaries("reasoning")).toEqual(["auto"])
  const [start] = told(events, "thinking.start")
  expect(start?.live).toBe(true)
  expect(told(events, "thinking.end")[0]?.text).toBe("The user wants a sum. Two and two make four.")
  const order = events.flatMap((event) =>
    event.type === "thinking.end" || event.type === "text.start" ? [event.type] : [],
  )
  expect(order).toEqual(["thinking.end", "text.start"])
})

test("Codex's reconnects are retries, and the error it gives up with ends the turn", async () => {
  const { events } = await replayed(error)
  expect(told(events, "retry").map((retry) => retry.attempt)).toEqual([1, 2])
  expect(told(events, "turn.end").map((end) => end.error)).toEqual([
    "We’re currently experiencing high demand, which may cause temporary errors.",
    null,
  ])
  expect(told(events, "notice")[0]?.text).toStartWith("`[features].web_search_request` is deprecated")
})

test("each kind of call ends with what it ran, found or wrote, and rewind counts every patched file", async () => {
  const { events, store, history } = await replayed(tools)
  expect(told(events, "tool.start").map((start) => [start.name, start.kind, start.title])).toEqual([
    ["exec_command", "read", "read"],
    ["exec_command", "search", "search"],
    ["exec_command", "search", "list"],
    ["exec_command", "shell", "shell"],
    ["apply_patch", "edit", "edit"],
    ["apply_patch", "edit", "edit"],
    ["web_search", "websearch", "websearch"],
    ["view_image", "read", "view image"],
  ])
  const [read, , , shell, added, deleted] = told(events, "tool.end")
  expect(read?.count).toEqual({ n: 3, noun: "line" })
  expect(shell).toMatchObject({ status: "error", exitCode: 3, result: "one\ntwo\n" })
  expect(told(events, "tool.called").find((call) => call.id === shell?.id)?.command).toBe(
    "printf 'one\\n'; sleep 0.4; printf 'two\\n'; exit 3",
  )
  expect(
    [...(added?.files ?? []), ...(deleted?.files ?? [])].map((file) => [file.path, file.change, file.movedTo]),
  ).toEqual([
    [`${PROJECT}/notes.md`, "create", null],
    [`${PROJECT}/src/a.ts`, "update", null],
    [`${PROJECT}/README.md`, "delete", null],
    [`${PROJECT}/notes.md`, "move", `${PROJECT}/docs/notes.md`],
  ])
  expect(deleted?.files[0]?.before).toBe("# demo\n\nA small project for Codex recordings.\n")
  const [point] = rewindPoints(store.state, null)
  expect(point?.files.map((file) => [file.path, file.created])).toEqual([
    ["notes.md", true],
    ["src/a.ts", false],
    ["README.md", false],
  ])
  // The history gives the calls back the same way.
  expect(told(history, "tool.end").map(shape)).toEqual(told(events, "tool.end").map(shape))
})

test("an MCP tool's row names its server", async () => {
  const { events } = await replayed(mcp)
  expect(told(events, "tool.start")).toMatchObject([{ kind: "mcp", mcp: { server: "echo", tool: "echo" } }])
  expect(told(events, "tool.end")[0]?.result).toBe("echo: hi there")
})

test("a subagent's thread goes under its spawn, as a task with its report", async () => {
  const { events, store, history } = await replayed(subagent)
  const [spawn] = told(events, "tool.start")
  expect(spawn).toMatchObject({ name: "spawnAgent", kind: "agent", parent: null })
  const [task] = told(events, "task.start")
  expect(task).toMatchObject({ kind: "agent", call: spawn?.id, prompt: "QUEBEC change the greeting" })
  const children = told(events, "tool.start").filter((start) => start.parent === spawn?.id)
  expect(children.map((start) => start.name)).toEqual(["exec_command", "apply_patch"])
  expect(told(events, "text.start").filter((start) => start.parent === spawn?.id)).toHaveLength(1)
  expect(told(events, "task.end")).toMatchObject([
    { id: task?.id, state: "completed", report: { summary: "The greeting now says hey." } },
  ])
  // The subagent's prompt and turn are none of the chat's.
  expect(told(events, "user")).toHaveLength(1)
  expect(told(events, "turn.end")).toHaveLength(1)
  expect(rewindPoints(store.state, null)[0]?.files.map((file) => file.path)).toEqual(["src/a.ts"])
  expect(told(history, "tool.start").map((start) => start.name)).toEqual(["spawnAgent", "wait"])
  expect(told(history, "task.end")).toHaveLength(1)
})

test("warnings and a rerouted model are notices; the model follows the reroute", () => {
  const translator = createTranslator("t1", { cwd: PROJECT, provider: "openai" })
  const at = 1
  const events = [
    ...translator.notification({ method: "warning", params: { threadId: null, message: "Slow down" } }, at),
    ...translator.notification({ method: "configWarning", params: { summary: "Bad key", details: "Fix it." } }, at),
    ...translator.notification(
      {
        method: "model/rerouted",
        params: { threadId: "t1", turnId: "u1", fromModel: "a", toModel: "b", reason: "highRiskCyberActivity" },
      },
      at,
    ),
    // Another thread's warning is not this session's.
    ...translator.notification({ method: "warning", params: { threadId: "t2", message: "Not ours" } }, at),
  ]
  expect(events.map((event) => (event.type === "notice" ? [event.level, event.text] : [event.type]))).toEqual([
    ["warning", "Slow down"],
    ["warning", "Bad key Fix it."],
    ["info", "Codex moved this turn from a to b"],
    ["model"],
    ["seen"],
  ])
})
