import { expect, test } from "bun:test"
import { createTranslator } from "./translate.ts"

const started = { id: "evt_1", created: 1, type: "session.execution.started" as const, data: { sessionID: "ses_1" } }

const stopped = (error: { type: string; message: string } | undefined) => ({
  id: "msg_1",
  time: { created: 2 },
  type: "assistant" as const,
  agent: "build",
  model: { id: "m", providerID: "p" },
  content: [],
  finish: "error",
  ...(error ? { error } : {}),
})

function endAfterResync(error: { type: string; message: string } | undefined, outcome: "failed" | null = null) {
  const translator = createTranslator()
  translator.event(started, 1)
  const events = translator.resynced({
    title: null,
    cost: 0,
    messages: [stopped(error)],
    running: false,
    outcome,
    permissions: [],
    forms: [],
    at: 3,
  })
  return events.find((event) => event.type === "turn.end")
}

// A rejected permission or a dismissed form ends the turn with an interrupt that stores no idle entry.
test("a missed turn end with no idle entry is read from the last step's error, else the session's outcome", () => {
  expect(endAfterResync({ type: "aborted", message: "Step interrupted" })).toMatchObject({ interrupted: true })
  expect(endAfterResync({ type: "provider", message: "quota" })).toMatchObject({ interrupted: false, error: "quota" })
  expect(endAfterResync(undefined, "failed")).toMatchObject({ error: "The turn failed" })
  expect(endAfterResync(undefined)).toMatchObject({ interrupted: false, error: null })
})

// opencode leaves the active list a moment before the last step's end is stored and sent.
test("a resync between a step's last part and its end leaves the turn to the stream", () => {
  const translator = createTranslator()
  translator.event(started, 1)
  const streamed = { ...stopped(undefined), finish: undefined, content: [{ type: "text" as const, text: "Done." }] }
  const resync = translator.resynced({
    title: null,
    cost: 0,
    messages: [streamed],
    running: false,
    outcome: null,
    permissions: [],
    forms: [],
    at: 3,
  })
  expect(resync.find((event) => event.type === "turn.end")).toBeUndefined()
  const tokens = { input: 1200, output: 180, reasoning: 0, cache: { read: 0, write: 0 } }
  const data = { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", tokens, cost: 0.01 }
  translator.event({ id: "evt_2", created: 4, type: "session.step.ended", data }, 4)
  const end = translator.event({ ...started, id: "evt_3", type: "session.execution.succeeded" }, 5)
  expect(end.find((event) => event.type === "turn.end")).toMatchObject({ inputTokens: 1200, outputTokens: 180 })
})

test("history ends a turn that stopped before its first step with a row", () => {
  const events = createTranslator().readBack([
    { id: "msg_1", time: { created: 1 }, type: "user", text: "hello" },
    { id: "msg_2", time: { created: 2 }, type: "idle", outcome: "interrupted" },
  ])
  expect(events.find((event) => event.type === "turn.end")).toMatchObject({ interrupted: true })
})

const row = (id: string, kind: "auto" | "plan" | "other") => ({
  id,
  label: id,
  description: "",
  kind,
  cycle: true,
  available: true,
  group: null,
})

// A write to `path` in plan mode, entered from review; the end of the turn.
function planTurn(path: string) {
  const translator = createTranslator()
  translator.within("/work")
  const rows = [row("build", "auto"), row("plan", "plan"), row("review", "other")]
  translator.modes({ rows, planFolders: ["/home/.opencode/plan/*"], models: new Map() }, "review", 0)
  const data = { sessionID: "ses_1", agent: "plan", previous: "review" }
  translator.event({ id: "evt_1", created: 1, type: "session.agent.selected", data }, 1)
  translator.event({ ...started, id: "evt_2", created: 2 }, 2)
  const tool = { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1" }
  translator.event({ id: "evt_3", created: 3, type: "session.tool.input.started", data: { ...tool, name: "write" } }, 3)
  const input = { path, content: "1. one" }
  translator.event({ id: "evt_4", created: 4, type: "session.tool.called", data: { ...tool, input } }, 4)
  translator.event({ id: "evt_5", created: 5, type: "session.tool.success", data: { ...tool, content: [] } }, 5)
  return translator.event({ ...started, id: "evt_6", type: "session.execution.succeeded" }, 6)
}

test("a plan goes on in build, whichever mode the session left for plan mode", () => {
  expect(planTurn("/home/.opencode/plan/a.md").at(-1)).toMatchObject({
    type: "plan",
    path: "/home/.opencode/plan/a.md",
    next: "build",
  })
})

test("a path that leaves the plan folder is no plan", () => {
  expect(planTurn("/home/.opencode/plan/../../.aws/credentials").at(-1)).toMatchObject({ type: "turn.end" })
})
