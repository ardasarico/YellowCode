import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import type { AgentScenario } from "../../../tools/opencode/scenario.ts"
import { bgShell, bgSubagent, subagent, tools } from "../../../tools/opencode/scenarios/tools.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { rewindPoints } from "../../session/rewind.ts"
import { createSession } from "../../session/session.ts"
import { createCuts } from "./cut.ts"
import { readFixture } from "./fixture.ts"
import { resync } from "./resync.ts"
import { createTranslator } from "./translate.ts"
import type { Reply, Transport } from "./transport.ts"
import { createEventReader } from "./wire/events.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const PROJECT = "<root>/project"
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${name}.jsonl`), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

const requests = (name: string) =>
  fixture(name).lines.flatMap((line) => (line.kind === "http" ? [`${line.method} ${line.path}`] : []))

const shape = (end: Extract<AgentEvent, { type: "tool.end" }>) => [end.status, end.result, end.files, end.exitCode]

// Replays the scenario into a store and checks it against its golden, written again only with
// UPDATE_OPENCODE_GOLDENS=1.
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
  const history = run.outputs.flatMap((output) => ("history" in output ? output.history.events : []))
  return { ...run, store, history }
}

test("each kind of call ends with what it wrote, ran or found, and rewind counts the written files", async () => {
  const { events, store, history } = await replayed(tools)
  expect(told(events, "tool.start").map((start) => [start.name, start.kind])).toEqual([
    ["read", "read"],
    ["glob", "search"],
    ["grep", "search"],
    ["edit", "edit"],
    ["write", "write"],
    ["write", "write"],
    ["shell", "shell"],
    ["webfetch", "fetch"],
  ])
  const [read, glob, grep, edit, created, replaced, shell, fetch] = told(events, "tool.end")
  expect(told(events, "tool.called")[0]?.summary).toBe(`${PROJECT}/src/a.ts`)
  expect([read?.count, glob?.count, grep?.count]).toEqual([
    { n: 1, noun: "line" },
    { n: 1, noun: "file" },
    { n: 1, noun: "match" },
  ])
  expect(edit?.files).toEqual([
    {
      path: `${PROJECT}/src/a.ts`,
      change: "update",
      movedTo: null,
      patch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-export const greeting = "hello"', '+export const greeting = "hi"'],
        },
      ],
      after: null,
    },
  ])
  expect(edit?.patch).toEqual(edit?.files[0]?.patch ?? null)
  expect(created).toMatchObject({ created: true, files: [{ path: `${PROJECT}/src/b.ts`, change: "create" }] })
  expect(replaced).toMatchObject({ created: false, files: [{ path: `${PROJECT}/README.md`, change: "update" }] })
  expect(replaced?.files[0]?.after).toBe("# demo\n\nChanged.\n")
  expect(shell).toMatchObject({ status: "error", exitCode: 3, result: "line 1\nline 2\nline 3\n\nExited with code 3" })
  expect(fetch).toMatchObject({ status: "error", result: "Transport error (GET https://example.com/)" })
  const [point] = rewindPoints(store.state, null)
  expect(point?.files.map((file) => [file.path, file.created])).toEqual([
    [`${PROJECT}/src/a.ts`, false],
    [`${PROJECT}/src/b.ts`, true],
    [`${PROJECT}/README.md`, false],
  ])
  // The history gives the calls back the same way.
  expect(told(history, "tool.end").map(shape)).toEqual(told(events, "tool.end").map(shape))
})

test("a subagent's session goes under its call, and a stop interrupts it", async () => {
  const { events, store, history } = await replayed(subagent)
  const [done, stopped] = told(events, "task.start")
  expect(done).toMatchObject({
    kind: "agent",
    call: "toolu_mock0001",
    agentType: "general",
    prompt: "QUEBEC change it",
  })
  const child = told(events, "tool.start").filter((start) => start.parent === "toolu_mock0001")
  expect(child.map((start) => start.name)).toEqual(["read", "edit"])
  expect(told(events, "text.start").filter((start) => start.parent !== null)).toHaveLength(1)
  expect(told(events, "task.end")).toMatchObject([
    { id: done?.id, state: "completed", report: { summary: "The greeting now says hey.", stoppedByUser: false } },
    { id: stopped?.id, state: "stopped", report: { stoppedByUser: true } },
  ])
  expect(requests("subagent")).toContain(`POST /api/session/${stopped?.id}/interrupt`)
  // The subagent's turns are no turns of the chat, and its edit counts for the prompt that started it.
  expect(told(events, "turn.end")).toHaveLength(2)
  expect(rewindPoints(store.state, null)[0]?.files.map((file) => file.path)).toEqual([`${PROJECT}/src/a.ts`])
  expect(told(history, "tool.start").map((start) => [start.name, start.parent])).toEqual([
    ["subagent", null],
    ["read", "toolu_mock0001"],
    ["edit", "toolu_mock0001"],
    ["subagent", null],
    ["read", "toolu_mock0004"],
  ])
  expect(told(history, "tool.end").find((end) => end.id === "toolu_mock0004")?.status).toBe("stopped")
})

test("a background shell ends in a turn of its own; Ctrl+B and a stop reach opencode", async () => {
  const { events, store, history } = await replayed(bgShell)
  const [first, second] = told(events, "task.start")
  expect(first).toMatchObject({ id: "sh_1", kind: "shell", background: true, description: "sleep 1; echo bg done" })
  expect(second).toMatchObject({ kind: "shell", background: false })
  expect(told(events, "task.output")).toMatchObject([{ id: first?.id, text: "bg done\n" }])
  expect(told(events, "turn.open").map((open) => open.endedTasks)).toEqual([[], ["sh_1"], [], []])
  expect(told(events, "task.update")).toMatchObject([{ id: second?.id, background: true }])
  expect(told(events, "task.end")).toMatchObject([
    { id: first?.id, state: "completed", report: { summary: "exit code 0" } },
    { id: second?.id, state: "stopped", report: { stoppedByUser: true } },
  ])
  const asked = requests("bg-shell")
  expect(asked).toContain("POST /api/session/ses_1/background")
  expect(asked).toContain(`DELETE /api/shell/${second?.id}`)
  expect(store.state.items.map((id) => store.state.byId[id]?.kind).filter((kind) => kind === "shell-end")).toHaveLength(
    2,
  )
  // Read back, the shell Ctrl+B moved is a background one too.
  expect(told(history, "tool.called").map((call) => call.background)).toEqual([true, true])
})

test("a background subagent and one Ctrl+B moved end in turns of their own", async () => {
  const { events, history } = await replayed(bgSubagent)
  expect(told(events, "task.start")).toMatchObject([
    { id: "ses_2", kind: "agent", background: true },
    { id: "ses_3", kind: "agent", background: false },
  ])
  expect(told(events, "task.update")).toMatchObject([{ id: "ses_3", background: true }])
  expect(told(events, "tool.end").filter((end) => end.task !== null)).toMatchObject([
    { id: "toolu_mock0001", background: true, task: "ses_2" },
    { id: "toolu_mock0003", background: true, task: "ses_3" },
  ])
  expect(told(events, "task.end")).toMatchObject([
    { id: "ses_2", state: "completed", report: { summary: "A demo." } },
    { id: "ses_3", state: "completed", report: { summary: "Says hello." } },
  ])
  expect(told(events, "turn.open").map((open) => open.endedTasks)).toEqual([[], ["ses_2"], [], ["ses_3"]])
  const calls = told(history, "tool.called").filter((call) => call.agent !== null)
  expect(calls.map((call) => call.background)).toEqual([true, true])
})

// Success metadata is open per tool: one that does not fit drops only its diff or exit code.
test("metadata that does not fit keeps the call's end", () => {
  const translator = createTranslator()
  const reader = createEventReader()
  const read = (type: string, data: Record<string, unknown>) => {
    const frame = reader({
      id: "evt",
      created: 1,
      type,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call", ...data },
    })
    return frame.kind === "event" ? translator.event(frame.event, 1) : []
  }
  read("session.tool.input.started", { name: "edit" })
  read("session.tool.called", { input: { path: "a.ts" } })
  const content = [{ type: "text", text: "Edited" }]
  expect(read("session.tool.success", { content, metadata: { files: "x" } })).toMatchObject([
    { type: "tool.end", status: "done", result: "Edited", files: [], patch: null },
  ])
  read("session.tool.input.started", { id: "shell", name: "shell" })
  read("session.tool.called", { id: "shell", input: { command: "ls" } })
  expect(read("session.tool.success", { id: "shell", content, metadata: { exit: "0" } })).toMatchObject([
    { type: "tool.end", status: "done", exitCode: null },
  ])
})

// The message list does not say when a background shell ended, so a resync asks opencode for each one still running.
test("a resync ends a background shell whose exit the stream missed", async () => {
  const translator = createTranslator()
  const reader = createEventReader()
  for (const line of fixture("bg-shell").lines) {
    const frame = line.kind === "sse" ? reader(line.event) : null
    if (frame?.kind !== "event" || frame.event.type === "shell.exited") continue
    if (translator.belongs(frame.event, "ses_1")) translator.event(frame.event, 1)
    if (frame.event.type === "session.tool.success") break
  }
  translator.gone(2)
  const session = {
    id: "ses_1",
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: PROJECT },
  }
  const replies: Record<string, unknown> = {
    "/api/session/ses_1": { data: session },
    "/api/session/ses_1/message": { data: [], cursor: {} },
    "/api/session/active": { data: {} },
    "/api/session/ses_1/permission": { data: [] },
    "/api/session/ses_1/form": { data: [] },
    "/api/shell/sh_1": { data: { id: "sh_1", status: "exited", exit: 0 } },
    "/api/shell/sh_1/output": { data: { output: "bg done\n", cursor: 8, size: 8, truncated: false } },
  }
  const transport: Transport = {
    request: ({ path }): Promise<Reply> => Promise.resolve({ status: 200, body: replies[path] }),
    events: async function* () {},
    socket: () => Promise.reject(new Error("no socket")),
  }
  const events = await resync(
    transport,
    "ses_1",
    translator,
    createCuts((id) => translator.forget(id)),
    3,
  )
  expect(events.filter((event) => event.type.startsWith("task."))).toMatchObject([
    { type: "task.end", id: "sh_1", state: "completed", report: { summary: "exit code 0" } },
    { type: "task.output", id: "sh_1", text: "bg done\n" },
  ])
  expect(translator.runningShells()).toEqual([])
})
