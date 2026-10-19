import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { answerQuestions, denyTool, QUESTION_TO_CHAT } from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import { parseRecording } from "../source/recording.ts"
import { createSession, withoutOpenMarkers } from "./session.ts"
import { exitCode, runningShellCount, shellEndStatus, shellStartedBy } from "./shells.ts"
import type { Item } from "./types.ts"

// With `until`, stops before the first line that contains it.
function replay(name: string, until?: string) {
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", `${name}.jsonl`)
  const session = createSession()
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries) {
    if (until && entry.line.includes(until)) break
    session.apply(entry.dir, parse(entry.line), entry.t)
  }
  return session
}

function feed(...messages: object[]) {
  const session = createSession()
  for (const message of messages) session.apply("in", parse(JSON.stringify(message)), 0)
  return session
}

const event = (inner: object, parent: string | null = null) => ({
  type: "stream_event",
  parent_tool_use_id: parent,
  event: inner,
})
const assistant = (id: string, block: object, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id, content: [block] },
})
const items = (session: ReturnType<typeof createSession>): Item[] => Object.values(session.state.byId)

test("the full assistant message wins over lost deltas", () => {
  const session = feed(
    event({ type: "message_start", message: { id: "m1" } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
    assistant("m1", { type: "text", text: "Hello" }),
    event({ type: "content_block_stop", index: 0 }),
  )

  const all = items(session)
  expect(all).toHaveLength(1)
  expect(all[0]).toMatchObject({ kind: "text", markdown: "Hello", streaming: false })
})

test("partial tool input stays raw text until the block completes", () => {
  const session = feed(
    event({ type: "message_start", message: { id: "m1" } }),
    event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
    }),
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"comm' } }),
  )
  expect(session.state.byId["t1"]).toMatchObject({ kind: "tool", inputText: '{"comm', input: undefined })

  session.apply(
    "in",
    parse(JSON.stringify(assistant("m1", { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }))),
    0,
  )
  expect(session.state.byId["t1"]).toMatchObject({ input: { command: "ls" }, summary: "ls" })
})

test("a tool result for an unknown tool call is ignored", () => {
  const session = feed({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] },
  })
  expect(session.state.items).toEqual([])
  expect(session.state.byId).toEqual({})
})

test("tools recording ends with every tool call finished and permissions answered", () => {
  const all = items(replay("tools"))
  expect(all.some((item) => item.kind === "tool")).toBe(true)
  expect(all.filter((item) => item.kind === "tool" && item.status === "running")).toEqual([])
  expect(all.some((item) => item.kind === "ask")).toBe(true)
  expect(all.filter((item) => item.kind === "ask" && item.status !== "allowed")).toEqual([])
})

const canUseTool = (extra: object) => ({
  type: "control_request",
  request_id: "r1",
  request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "t1", input: { command: "ls" }, ...extra },
})

test("an ask offers the first suggestion that is not switching to auto mode", () => {
  const session = feed(
    canUseTool({
      description: "List files",
      permission_suggestions: [
        { type: "setMode", mode: "auto", destination: "session" },
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow" },
      ],
    }),
  )
  expect(session.state.byId["ask-r1"]).toMatchObject({
    description: "List files",
    status: "pending",
    suggestion: { type: "addRules" },
  })
})

test("an ask offers no suggestion when always allow is suppressed", () => {
  const session = feed(
    canUseTool({
      suppress_always_allow_rule: true,
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow" }],
    }),
  )
  expect(session.state.byId["ask-r1"]).toMatchObject({ suggestion: null })
})

const settle = (response: object) => {
  const session = feed(canUseTool({}))
  const reply = { type: "control_response", response: { subtype: "success", request_id: "r1", response } }
  session.apply("out", parse(JSON.stringify(reply)), 0)
  return session.state.byId["ask-r1"]
}

test("the outgoing response settles the ask", () => {
  expect(settle({ behavior: "deny", message: "no" })).toMatchObject({ status: "denied" })
  expect(settle({ behavior: "allow", updatedInput: {} })).toMatchObject({ status: "allowed" })
  expect(
    settle({
      behavior: "allow",
      updatedInput: { answers: { "Which?": "A" }, annotations: { "Which?": { notes: "because" } } },
    }),
  ).toMatchObject({ status: "answered", answers: { "Which?": "A" }, notes: { "Which?": "because" } })
})

test("a recorded response does not overwrite the user's own answer", () => {
  const session = feed(canUseTool({}))
  session.answer(denyTool("r1", QUESTION_TO_CHAT))
  session.apply("out", parse(answerQuestions("r1", { questions: [{ question: "Which?" }] }, { "Which?": "A" }, {})), 0)
  expect(session.state.byId["ask-r1"]).toMatchObject({ status: "denied", answers: {}, denial: QUESTION_TO_CHAT })
})

test("subagent messages land under the Agent tool call", () => {
  const session = replay("subagent")
  const agent = items(session).find((item) => item.kind === "tool" && (item.name === "Agent" || item.name === "Task"))
  expect(agent?.kind === "tool" && agent.children.length > 0).toBe(true)
  const topLevel = new Set(session.state.items)
  const children = agent?.kind === "tool" ? agent.children : []
  expect(children.filter((id) => topLevel.has(id))).toEqual([])
})

const result = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  total_cost_usd: 0,
  duration_ms: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
}
const streamingText = () =>
  feed(
    event({ type: "message_start", message: { id: "m1" } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
  )
const streaming = (session: ReturnType<typeof createSession>) =>
  items(session).filter((item) => (item.kind === "text" || item.kind === "thinking") && item.streaming)

test("a result stops streaming even when the final message never arrived", () => {
  const session = streamingText()
  expect(streaming(session)).toHaveLength(1)

  session.apply("in", parse(JSON.stringify(result)), 0)
  expect(streaming(session)).toEqual([])
  expect(items(session).some((item) => item.kind === "turn-end")).toBe(true)
})

test("a result settles its tools without a result, but not background work", () => {
  const session = feed(
    event({ type: "message_start", message: { id: "m1" } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    event({ type: "message_start", message: { id: "m2" } }),
    assistant("m2", { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }),
    assistant("m2", { type: "tool_use", id: "t2", name: "Bash", input: { command: "sleep 9" } }),
    started({ task_id: "b1", tool_use_id: "t2", task_type: "local_bash", is_backgrounded: true }),
    result,
  )
  expect(streaming(session)).toEqual([])
  expect(session.state.byId["t1"]).toMatchObject({ status: "stopped" })
  expect(session.state.byId["t2"]).toMatchObject({ status: "running" })
})

test("ending the session stops anything still streaming", () => {
  const session = streamingText()
  session.end()
  expect(streaming(session)).toEqual([])
  expect(session.state.status).toBe("ended")
})

test("an assistant message without stream events produces one finished item", () => {
  const session = feed(assistant("m1", { type: "text", text: "Hello" }))
  expect(session.state.items).toHaveLength(1)
  expect(items(session)).toMatchObject([{ kind: "text", markdown: "Hello", streaming: false }])
})

test("a streamed thinking block then text block yield two items", () => {
  const session = feed(
    event({ type: "message_start", message: { id: "m1" } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    assistant("m1", { type: "thinking", thinking: "" }),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } }),
    assistant("m1", { type: "text", text: "Hello" }),
    event({ type: "content_block_stop", index: 1 }),
  )
  expect(items(session)).toMatchObject([
    { kind: "thinking", streaming: false },
    { kind: "text", markdown: "Hello", streaming: false },
  ])
  expect(session.state.items).toHaveLength(2)
})

test("repeated invalid messages of one kind produce a single counted warning", () => {
  const session = feed(
    { type: "stream_event", event: 1 },
    { type: "stream_event", event: 2 },
    { type: "stream_event", event: 3 },
  )
  const warnings = items(session).filter((item) => item.kind === "system")
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.kind === "system" && warnings[0].text.includes("3")).toBe(true)
})

test("a user image keeps its data", () => {
  const user = items(replay("image")).find((item) => item.kind === "user")
  const images = user?.kind === "user" ? user.images : []
  expect(images.map((image) => image.mediaType)).toEqual(["image/png"])
  expect(images[0]?.data?.length).toBeGreaterThan(0)
})

test("a Read of an image carries the image, named after the file", () => {
  const read = items(replay("read-image")).find((item) => item.kind === "tool" && item.name === "Read")
  const images = read?.kind === "tool" ? read.images : []
  expect(images).toHaveLength(1)
  expect({ ...images[0] }).toMatchObject({
    name: "shot.png",
    mediaType: "image/png",
    path: "/Users/user/project/shot.png",
  })
  expect(images[0]?.data?.length).toBeGreaterThan(0)
  expect(read).toMatchObject({ result: "" })
})

test("file edits carry their patch", () => {
  const edit = items(replay("tools")).find((item) => item.kind === "tool" && item.name === "Edit")
  expect(edit?.kind === "tool" && edit.patch).toHaveLength(1)
  const write = items(replay("permission")).find((item) => item.kind === "tool" && item.name === "Write")
  expect(write).toMatchObject({ createdFile: true })
})

test("a Read answered with file_unchanged is marked unchanged", () => {
  const read = items(replay("commands")).find((item) => item.kind === "tool" && item.name === "Read")
  expect(read).toMatchObject({ unchanged: true })
})

test("an Agent call carries the agent's name and task", () => {
  const agent = items(replay("subagent")).find((item) => item.kind === "tool" && item.name === "Agent")
  expect(agent).toMatchObject({ agent: { name: "general-purpose", task: "List files in working directory" } })
})

test("an interrupted turn ends interrupted", () => {
  const ends = items(replay("error")).filter((item) => item.kind === "turn-end")
  expect(ends.map((item) => item.kind === "turn-end" && item.interrupted)).toEqual([false, true])
})

test("an interrupted reply drops the marker it stopped after", () => {
  const { items: ids, byId } = replay("error").state
  expect(ids.slice(-2).map((id) => byId[id]?.kind)).toEqual(["thinking", "turn-end"])
  expect(withoutOpenMarkers("Once upon a **ti")).toBe("Once upon a ti")
  expect(withoutOpenMarkers("run `bun te")).toBe("run bun te")
  expect(withoutOpenMarkers("a **b** and *c")).toBe("a **b** and c")
  expect(withoutOpenMarkers("2 * 3 in my_var")).toBe("2 * 3 in my_var")
})

test("an API error reply leaves the text and the context size to the turn end", () => {
  const usage = { input_tokens: 1200 }
  const session = feed(
    { type: "assistant", message: { id: "a", model: "claude-opus-5-5", content: [], usage } },
    {
      type: "assistant",
      is_api_error_message: true,
      message: {
        id: "b",
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: 400" }],
        usage: { input_tokens: 0 },
      },
    },
  )
  expect(items(session)).toEqual([])
  expect(session.state.usage.context.used).toBe(1200)
})

test("thinking text fills from the stream", () => {
  const thinking = items(replay("thinking")).filter((item) => item.kind === "thinking")
  expect(thinking.length).toBeGreaterThan(0)
  expect(thinking.every((item) => item.kind === "thinking" && item.text.length > 0)).toBe(true)
})

test("background agents take their outcome from task notifications", () => {
  const agents = items(replay("agents")).flatMap((item) => (item.kind === "tool" && item.agent ? [item.agent] : []))
  expect(agents.map((agent) => [agent.name, agent.state, agent.toolUses])).toEqual([
    ["readme", "completed", 1],
    ["source", "completed", 1],
    ["missing", "completed", 1],
  ])
  expect(agents.every((agent) => agent.report.length > 0 && agent.durationMs > 0)).toBe(true)
})

test("usage adds up tokens, the context window and plan limits", () => {
  const usage = replay("chat").state.usage
  expect(usage.tokens).toBe(2 + 586 + 3856 + 13961 + (2 + 46 + 625 + 17817))
  expect(usage.context.window).toBe(1_000_000)
  expect(usage.limits.fiveHour?.utilization).toBe(0.32)
})

test("MCP servers keep their status", () => {
  const servers = replay("mcp").state.info?.mcpServers.map((server) => [server.name, server.status])
  expect(servers).toEqual([
    ["echo", "connected"],
    ["broken", "failed"],
  ])
})

test("nested agents join into one task tree and keep their own steps", () => {
  const session = replay("nested-agents")
  const tasks = Object.values(session.state.tasks)
  const outer = tasks.find((task) => task.name === "outer")
  expect(tasks.map((task) => [task.name, task.parentId, task.depth, task.background, task.state])).toEqual([
    ["outer", null, 1, false, "completed"],
    ["inner-fg", outer?.id ?? "", 2, false, "completed"],
    ["inner-bg", outer?.id ?? "", 2, true, "completed"],
  ])
  const outerCall = session.state.byId[outer?.toolUseId ?? ""]
  const steps = outerCall?.kind === "tool" ? outerCall.children.map((id) => session.state.byId[id]) : []
  expect(steps.flatMap((item) => (item?.kind === "tool" ? [item.name] : []))).toEqual(["Agent", "Agent"])
  const agent = outerCall?.kind === "tool" ? outerCall.agent : null
  expect(agent?.prompt).toStartWith("Use the Agent tool twice in one message.")
  expect(agent).toMatchObject({ model: "claude-haiku-5-5", tokens: 13664 })
})

test("a background task runs until its notification, not its launch result", () => {
  const before = replay("nested-agents", '"subtype":"task_updated","task_id":"a62fa8cd579dd30f0"')
  const innerBg = items(before).find((item) => item.kind === "tool" && item.agent?.name === "inner-bg")
  expect(innerBg).toMatchObject({ agent: { state: "running" } })

  const bash = (session: ReturnType<typeof createSession>) =>
    items(session).find((item) => item.kind === "tool" && item.name === "Bash" && item.summary.startsWith("sleep"))
  expect(bash(replay("background-bash", '"subtype":"task_updated"'))).toMatchObject({ status: "running" })
  expect(bash(replay("background-bash"))).toMatchObject({ status: "done" })
})

const started = (extra: object) => ({ type: "system", subtype: "task_started", description: "d", ...extra })
const live = (ids: string[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((task_id) => ({ task_id, task_type: "local_bash", description: "d" })),
})

test("the live background set decides what still runs", () => {
  const session = feed(
    live(["lost"]),
    started({ task_id: "lost", task_type: "local_bash", is_backgrounded: true }),
    started({ task_id: "orphan", task_type: "local_agent", parent_task_id: "ghost" }),
    started({ task_id: "quiet", ambient: true }),
    live([]),
  )
  expect(session.state.tasks["lost"]).toMatchObject({ state: "stopped", background: true })
  expect(session.state.tasks["orphan"]).toMatchObject({ state: "running", parentId: null })
  expect(session.state.tasks["quiet"]).toBeUndefined()
})

test("a workflow task keeps its latest progress snapshot", () => {
  const workflow = Object.values(replay("workflow").state.tasks)[0]?.workflow
  expect(workflow?.phases).toEqual([{ index: 1, title: "Read" }])
  expect(workflow?.agents.map((agent) => [agent.label, agent.state])).toEqual([
    ["read:a.txt", "done"],
    ["read:b.txt", "done"],
  ])
  expect(workflow?.agents[0]).toMatchObject({
    prompt: "Read the file /Users/user/project/a.txt and return its exact content as your final text, nothing else.",
    tokens: 9322,
    lastToolSummary: "/Users/user/project/a.txt",
  })
})

test("shells keep their command, outcome, exit code and output", () => {
  const session = replay("shells")
  const tasks = Object.values(session.state.tasks)
  const byCommand = (word: string) => tasks.find((task) => task.command.includes(word))
  const tick = byCommand("tick")
  const step = byCommand("step")
  const wait = byCommand("wait")
  expect([tick?.state, tick && exitCode(tick), tick?.output?.endsWith("tick 60\n")]).toEqual(["completed", 0, true])
  expect([step?.state, step && exitCode(step), step?.output?.includes("boom")]).toEqual(["failed", 1, true])
  expect([wait?.state, wait && exitCode(wait)]).toEqual(["stopped", null])
  const limited = wait && {
    ...wait,
    summary: `Background command "x" was stopped after reaching its background time limit`,
  }
  expect(limited && shellEndStatus(limited)).toEndWith("was stopped (time limit)")

  const ends = session.state.items.flatMap((id) => {
    const item = session.state.byId[id]
    return item?.kind === "shell-end" ? [session.state.tasks[item.taskId]] : []
  })
  expect(ends).toEqual([step, wait, tick])

  expect(runningShellCount(replay("shells", '"subtype":"task_updated"').state)).toBe(3)
})

test("a shell a subagent started names that subagent", () => {
  const state = replay("agent-shell").state
  const shell = Object.values(state.tasks).find((task) => task.type === "local_bash")
  expect(shell && shellStartedBy(state, shell)).toBe("starter")
})

test("a shell without recorded output still has its exit code", () => {
  const shell = Object.values(replay("background-bash").state.tasks)[0]
  expect(shell?.output).toBeNull()
  expect(shell && exitCode(shell)).toBe(0)
})

test("a message sent after a rewind drops the rewound prompts, and a redo before it keeps them", () => {
  const session = replay("rewind", "Rename the config file to settings.json, but")
  const users = session.state.items.filter((id) => session.state.byId[id]?.kind === "user")
  const third = users[2] ?? ""
  session.rewind({ userId: third, prompts: 3, files: 0, keptFiles: false })
  session.redo()
  expect(session.state.items.includes(third)).toBe(true)
  session.rewind({ userId: third, prompts: 3, files: 0, keptFiles: false })
  const message = { type: "user", message: { role: "user", content: "Rename it, with a fallback" } }
  session.apply("out", parse(JSON.stringify(message)), 0)
  const shown = session.state.items.filter((id) => session.state.byId[id]?.kind === "user")
  expect(shown).toHaveLength(3)
  expect(shown.includes(third)).toBe(false)
  expect(session.state.rewound).toBeNull()
})
