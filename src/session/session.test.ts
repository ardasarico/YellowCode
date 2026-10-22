import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  allowTool,
  answerQuestions,
  denyTool,
  interruptRequest,
  QUESTION_TO_CHAT,
  userMessage,
} from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import { parseRecording } from "../source/recording.ts"
import { agentMessage } from "./agent-message.ts"
import { LOGIN_HINT } from "./login.ts"
import { createSession, withoutOpenMarkers } from "./session.ts"
import { exitCode, runningShellCount, shellEndStatus, shellStartedBy } from "./shells.ts"
import type { Item } from "./types.ts"

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

test("allowing a tool whose own input has annotations settles its ask as allowed", () => {
  const input = { path: "a.ts", annotations: [{ line: 1, message: "x" }] }
  const session = feed(canUseTool({ tool_name: "mcp__fake__annotate", input }))
  session.apply("out", parse(allowTool("r1", input)), 0)
  expect(rows(session)).toMatchObject([{ kind: "ask", status: "allowed" }])
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

const settle = (response: object, ask: object = {}) => {
  const session = feed(canUseTool(ask))
  const reply = { type: "control_response", response: { subtype: "success", request_id: "r1", response } }
  session.apply("out", parse(JSON.stringify(reply)), 0)
  return session.state.byId["ask-r1"]
}

test("the outgoing response settles the ask", () => {
  expect(settle({ behavior: "deny", message: "no" })).toMatchObject({ status: "denied" })
  expect(settle({ behavior: "allow", updatedInput: {} })).toMatchObject({ status: "allowed" })
  expect(
    settle(
      {
        behavior: "allow",
        updatedInput: { answers: { "Which?": "A" }, annotations: { "Which?": { notes: "because" } } },
      },
      { tool_name: "AskUserQuestion" },
    ),
  ).toMatchObject({ status: "answered", answers: { "Which?": "A" }, notes: { "Which?": "because" } })
})

test("claude cancelling an ask closes it, unless the user answered first", () => {
  const cancel = { type: "control_cancel_request", request_id: "r1" }
  expect(feed(canUseTool({}), cancel).state.byId["ask-r1"]).toMatchObject({ status: "cancelled" })
  const answered = feed(canUseTool({}))
  answered.answer(allowTool("r1", {}))
  answered.apply("in", parse(JSON.stringify(cancel)), 0)
  expect(answered.state.byId["ask-r1"]).toMatchObject({ status: "allowed" })
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

const retry = (attempt: number) => ({
  type: "system",
  subtype: "api_retry",
  attempt,
  max_retries: 10,
  retry_delay_ms: 1000,
  error_status: 529,
  error: "overloaded",
})
const rows = (session: ReturnType<typeof createSession>) =>
  session.state.items.map((id) => session.state.byId[id]).filter((item) => item !== undefined)

test("API retries collapse into one row that goes once the reply streams", () => {
  const retrying = rows(replay("api-retry", "message_start")).filter((item) => item.kind === "system")
  expect(retrying).toMatchObject([{ retry: { attempt: 2, max: 10, status: 529, reason: "overloaded" } }])
  const answered = rows(replay("api-retry", '"Now list three risks'))
  expect(answered.map((item) => item.kind)).toEqual(["user", "text", "turn-end"])
})

test("a turn that fails after retrying keeps only its end, with the retry count", () => {
  const session = feed(retry(1), retry(2), {
    type: "result",
    subtype: "success",
    is_error: true,
    total_cost_usd: 0,
    duration_ms: 41000,
    usage: { input_tokens: 0, output_tokens: 0 },
    result: "API Error: 529 Overloaded",
  })
  expect(rows(session)).toMatchObject([{ kind: "turn-end", error: "API Error: 529 Overloaded", retries: 2 }])
})

const failedLogin = (text: string) =>
  rows(
    feed(
      {
        type: "assistant",
        is_api_error_message: true,
        error: "authentication_failed",
        message: { id: "a", model: "<synthetic>", content: [{ type: "text", text }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        total_cost_usd: 0,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        result: text,
      },
    ),
  )

test("a failed login adds the sign-in hint after the turn, an invalid API key does not", () => {
  expect(failedLogin("Not logged in · Please run /login")).toMatchObject([
    { kind: "turn-end", error: "Not logged in · Please run /login" },
    { kind: "system", level: "warning", text: LOGIN_HINT },
  ])
  expect(failedLogin("Invalid API key · Fix external API key").map((item) => item.kind)).toEqual(["turn-end"])
})

test("an interrupted turn ends interrupted, not failed, with its tool stopped and claude's rejection hidden", () => {
  const session = createSession()
  const send = (line: string) => session.apply("out", parse(line), 0)
  const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  send(userMessage("run it"))
  receive(assistant("a", { type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 20" } }))
  receive({ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "t1", task_type: "local_bash" })
  send(interruptRequest("yc-1"))
  receive({
    type: "control_response",
    response: { subtype: "success", request_id: "yc-1", response: { still_queued: [] } },
  })
  receive({
    type: "system",
    subtype: "task_notification",
    task_id: "k1",
    status: "stopped",
    summary: "",
    output_file: "",
  })
  receive({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "t1", is_error: true, content: "The user doesn't want to proceed" },
      ],
    },
    tool_result_meta: [{ id: "t1", non_execution_kind: "user-rejected" }],
  })
  receive({
    type: "user",
    message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
  })
  receive({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    total_cost_usd: 0,
    duration_ms: 9100,
    usage: { input_tokens: 0, output_tokens: 0 },
    errors: ["[ede_diagnostic] result_type=user"],
  })

  expect(session.state.byId["t1"]).toMatchObject({ status: "stopped", result: "" })
  expect(rows(session).at(-1)).toMatchObject({ kind: "turn-end", interrupted: true, error: null })
  expect(session.state).toMatchObject({ status: "idle", interrupting: false })
})

test("an interrupt that goes out after its turn's result marks no later turn as interrupted", () => {
  const session = createSession()
  const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  const ended = {
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    result: "ok",
  }
  session.apply("out", parse(userMessage("hi")), 0)
  receive(assistant("a1", { type: "text", text: "first answer" }))
  receive(ended)
  session.apply("out", parse(interruptRequest("yc-2")), 0)
  receive({ type: "control_response", response: { subtype: "success", request_id: "yc-2", response: {} } })
  expect(session.state.interrupting).toBe(false)

  // claude starts a turn of its own, for a background task that ended.
  receive(assistant("a2", { type: "text", text: "the shell printed **done" }))
  receive(ended)
  expect(rows(session).at(-1)).toMatchObject({ kind: "turn-end", interrupted: false })
  expect(rows(session).at(-2)).toMatchObject({ kind: "text", markdown: "the shell printed **done" })
})

test("a message sent during a turn waits as queued, outlives an interrupt and runs as the next turn", () => {
  const session = createSession()
  const send = (line: string) => session.apply("out", parse(line), 0)
  const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  const queued = () => rows(session).find((item) => item.kind === "user" && item.text === "also this")
  send(userMessage("run it"))
  receive(assistant("a", { type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 20" } }))
  send(userMessage("also this", [], "u2"))
  expect(queued()).toMatchObject({ queue: "queued" })

  send(interruptRequest("yc-1"))
  receive(result)
  expect(rows(session).find((item) => item.kind === "turn-end")).toMatchObject({ interrupted: true })
  expect(session.state.status).toBe("running")
  expect(queued()).toMatchObject({ queue: "queued" })

  receive({ type: "command_lifecycle", command_uuid: "u2", state: "started" })
  expect(queued()).toMatchObject({ queue: null })
  receive({ ...result, subtype: "success", is_error: false })
  expect(rows(session).findLast((item) => item.kind === "turn-end")).toMatchObject({ interrupted: false })
  expect(session.state.status).toBe("idle")
})

test("only a turn in progress can be interrupted, and the session knows who started it", () => {
  const session = createSession()
  const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  session.apply("out", parse(userMessage("run it")), 0)
  receive(assistant("a", { type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 9" } }))
  session.apply("out", parse(userMessage("also this", [], "u2")), 0)
  receive({ ...result, subtype: "success", is_error: false, queued_turn_count: 1 })
  // u2 is still waiting: the session stays running, but no turn is in progress to interrupt.
  expect(session.state).toMatchObject({ status: "running", turn: null })
  session.apply("out", parse(interruptRequest("yc-1")), 0)
  expect(session.state.interrupting).toBe(false)

  receive({ type: "command_lifecycle", command_uuid: "u2", state: "started" })
  receive({ type: "system", subtype: "status", status: "requesting", user_message_uuids: ["u2"] })
  expect(session.state).toMatchObject({ status: "running", turn: "user" })
  receive({ ...result, subtype: "success", is_error: false, queued_turn_count: 1 })
  // A count of queued turns alone holds nothing.
  expect(session.state).toMatchObject({ status: "idle", turn: null })

  // A turn claude starts on its own, after a background task ended, is claude's (Ctrl+C does not interrupt it).
  receive({ type: "system", subtype: "status", status: "requesting" })
  expect(session.state).toMatchObject({ status: "running", turn: "claude" })
})

test("/clear starts the chat over but keeps a message sent after it, and local commands get no turn end", () => {
  const session = createSession()
  const send = (line: string) => session.apply("out", parse(line), 0)
  const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  const done = { ...result, subtype: "success", is_error: false, total_cost_usd: 0.5 }
  const local = (command: string) => ({ ...done, usage: { input_tokens: 0, output_tokens: 0 }, local_command: command })
  send(userMessage("a", [], "u1"))
  receive(assistant("m1", { type: "text", text: "x" }))
  receive(done)
  send(userMessage("/compact", [], "u2"))
  receive({ type: "system", subtype: "status", status: "compacting" })
  // A mode change during the compaction says nothing about it.
  receive({ type: "system", subtype: "status", status: null, permissionMode: "acceptEdits" })
  expect(session.state.compacting).toBe(true)
  receive({ type: "system", subtype: "status", status: null, compact_result: "success" })
  receive({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", post_tokens: 1200 } })
  receive(local("compact"))
  expect(session.state).toMatchObject({ compacting: false, usage: { context: { used: 1200 } } })
  expect(rows(session).map((item) => item.kind)).toEqual(["user", "text", "turn-end", "user", "system"])

  send(userMessage("/clear", [], "u3"))
  send(userMessage("b", [], "u4"))
  receive({ type: "conversation_reset", new_conversation_id: "c2", trigger: "clear", user_message_uuid: "u3" })
  receive({ ...local("clear"), total_cost_usd: 0, user_message_uuids: ["u3"] })
  expect(rows(session)).toMatchObject([{ kind: "user", text: "b", queue: "queued" }])
  expect(session.state).toMatchObject({ conversation: 1, status: "running", usage: { tokens: 0, costUsd: 0 } })
})

test("/clear keeps a running background agent off the chat with its steps, and an ask still open", () => {
  const session = createSession()
  const send = (line: string) => session.apply("out", parse(line), 0)
  const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  const input = { description: "d", prompt: "p", subagent_type: "general-purpose", run_in_background: true }
  send(userMessage("start", [], "u1"))
  receive(assistant("m1", { type: "tool_use", id: "ag1", name: "Agent", input }))
  receive({ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "ag1", is_backgrounded: true })
  receive(assistant("s1", { type: "text", text: "sub step" }, "ag1"))
  receive({ ...result, subtype: "success", is_error: false })
  receive(canUseTool({ tool_use_id: "t9" }))
  send(userMessage("/clear", [], "u2"))
  receive({ type: "conversation_reset", new_conversation_id: "c2" })
  receive(assistant("s2", { type: "text", text: "sub later" }, "ag1"))
  receive(assistant("s3", { type: "text", text: "lost" }, "gone"))

  expect(rows(session).map((item) => item.kind)).toEqual(["ask"])
  expect(session.state.carried).toEqual(["ag1"])
  const agent = session.state.byId["ag1"]
  const steps = agent?.kind === "tool" ? agent.children.map((id) => session.state.byId[id]) : []
  expect(steps).toMatchObject([{ markdown: "sub step" }, { markdown: "sub later" }])
  expect(items(session).some((item) => item.kind === "text" && item.markdown === "lost")).toBe(false)
})

const agentCall = (id: string, background: boolean) => ({
  type: "tool_use",
  id,
  name: "Agent",
  input: { description: id, prompt: "p", subagent_type: "general-purpose", run_in_background: background },
})

test("/clear carries a background agent that a finished foreground agent started", () => {
  const session = createSession()
  const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  session.apply("out", parse(userMessage("start", [], "u1")), 0)
  receive(assistant("m1", agentCall("outer", false)))
  receive({ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "outer" })
  receive(assistant("s1", agentCall("inner", true), "outer"))
  receive({ type: "system", subtype: "task_started", task_id: "k2", tool_use_id: "inner", is_backgrounded: true })
  receive({ type: "system", subtype: "task_notification", task_id: "k1", status: "completed", summary: "" })
  receive({ ...result, subtype: "success", is_error: false })
  receive({ type: "conversation_reset", new_conversation_id: "c2" })
  expect(session.state.carried).toEqual(["inner"])
  receive(assistant("s2", { type: "text", text: "inner step" }, "inner"))
  const inner = session.state.byId["inner"]
  expect(inner?.kind === "tool" && inner.children.map((id) => session.state.byId[id])).toMatchObject([
    { markdown: "inner step" },
  ])
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
  expect(usage.limits.fiveHour?.utilization).toBe(0.3)
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
  session.rewind({ userId: third, prompts: 3, files: [], keptFiles: false })
  session.redo()
  expect(session.state.items.includes(third)).toBe(true)
  session.rewind({ userId: third, prompts: 3, files: [], keptFiles: false })
  const message = { type: "user", message: { role: "user", content: "Rename it, with a fallback" } }
  session.apply("out", parse(JSON.stringify(message)), 0)
  const shown = session.state.items.filter((id) => session.state.byId[id]?.kind === "user")
  expect(shown).toHaveLength(3)
  expect(shown.includes(third)).toBe(false)
  expect(session.state.rewound).toBeNull()
})

const toolCall = (id: string, name: string, input: object) =>
  assistant(`m-${id}`, { type: "tool_use", id, name, input })
const taskStartedOn = (toolUseId: string, prompt: string) => ({
  type: "system",
  subtype: "task_started",
  task_id: "a1",
  tool_use_id: toolUseId,
  description: "probe kilo",
  prompt,
  task_type: "local_agent",
})

test("a resumed agent keeps its name and runs as a new row on the SendMessage call", () => {
  const session = feed(
    toolCall("t-agent", "Agent", { name: "kilo", description: "probe kilo", prompt: "first job", subagent_type: "x" }),
    taskStartedOn("t-agent", "first job"),
    {
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      tool_use_id: "t-agent",
      status: "completed",
      summary: "first report",
    },
    toolCall("t-send", "SendMessage", { to: "a1", message: "second job\nmore", summary: "relay" }),
    taskStartedOn("t-send", "second job"),
  )

  const { byId, tasks } = session.state
  expect(tasks.a1).toMatchObject({ name: "kilo", toolUseId: "t-send", state: "running" })
  expect(byId["t-send"]).toMatchObject({ summary: "kilo · second job", taskId: "a1" })
  expect(byId["t-send"]).toMatchObject({ agent: { name: "kilo", prompt: "second job", state: "running" } })
  expect(byId["t-agent"]).toMatchObject({ agent: { state: "completed" } })
})

test("an Agent call read back from a transcript takes its agent id from the result", () => {
  const session = feed(
    assistant("m1", { type: "tool_use", id: "t1", name: "Agent", input: { name: "kilo", prompt: "job" } }),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
      tool_use_result: { agentId: "a9" },
    },
  )

  expect(session.state.byId.t1).toMatchObject({ taskId: "a9" })
})

test("a message to an agent shows as its text with the agent, live and replayed", () => {
  const content = agentMessage("a1", "kilo", "hello")
  for (const isReplay of [false, true]) {
    const session = createSession()
    session.apply(
      "out",
      parse(
        JSON.stringify({
          type: "user",
          parent_tool_use_id: null,
          uuid: "u1",
          isReplay,
          message: { role: "user", content },
        }),
      ),
      0,
    )
    expect(items(session)[0]).toMatchObject({ kind: "user", text: "hello", to: { id: "a1", name: "kilo" } })
  }
})

const forAgent = (reply: string) => {
  const session = createSession()
  session.apply(
    "out",
    parse(
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        uuid: "u1",
        message: { role: "user", content: agentMessage("a1", "kilo", "hello") },
      }),
    ),
    0,
  )
  for (const message of [
    assistant("m1", { type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "select:SendMessage" } }),
    assistant("m2", { type: "tool_use", id: "t2", name: "SendMessage", input: { to: "a1", message: "hello" } }),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: reply }] },
    },
    assistant("m3", { type: "text", text: "Passed it on." }),
  ])
    session.apply("in", parse(JSON.stringify(message)), 0)
  return session.state.byId
}

test("the main model's turn for a message to an agent stays quiet, with a muted delivery on the message", () => {
  const byId = forAgent('{"success":true,"message":"Message queued for delivery to kilo"}')
  expect(byId.t1).toMatchObject({ quiet: true })
  expect(byId.t2).toMatchObject({ quiet: true })
  expect(Object.values(byId).find((item) => item.kind === "text")).toMatchObject({ quiet: true })
  expect(Object.values(byId).find((item) => item.kind === "user")).toMatchObject({ delivery: "sent" })
})

test("a refused message to an agent shows the turn in full", () => {
  const byId = forAgent('{"success":false,"message":"no such agent"}')
  expect(byId.t1).toMatchObject({ quiet: false })
  expect(byId.t2).toMatchObject({ quiet: false })
  expect(Object.values(byId).find((item) => item.kind === "user")?.delivery).toBeUndefined()
})

function wrapperTurn(sendWhileRunning: boolean, plainAfter?: string) {
  const session = createSession()
  const send = (message: object) => session.apply("out", parse(JSON.stringify(message)), 0)
  const take = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  const turnResult = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  if (sendWhileRunning) send({ type: "user", uuid: "u0", message: { role: "user", content: "go slow" } })
  send({ type: "user", uuid: "u1", message: { role: "user", content: agentMessage("a1", "kilo", "hello") } })
  if (plainAfter) send({ type: "user", uuid: "u3", message: { role: "user", content: plainAfter } })
  take(assistant("m1", { type: "tool_use", id: "t2", name: "SendMessage", input: { to: "a1", message: "hello" } }))
  take({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: '{"success":true}' }] },
  })
  return { session, take, turnResult }
}

test("a real answer in a turn the message was folded into is never hidden", () => {
  const { session, take } = wrapperTurn(true)
  take(assistant("m2", { type: "text", text: "slow turn done" }))
  expect(items(session).find((item) => item.kind === "text")?.quiet).not.toBe(true)
})

test("nothing stays quiet after the turn ends", () => {
  const { session, take, turnResult } = wrapperTurn(false)
  take(turnResult)
  session.apply(
    "out",
    parse(JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "time?" } })),
    0,
  )
  take(assistant("m3", { type: "text", text: "Noon." }))
  expect(items(session).find((item) => item.kind === "text")?.quiet).not.toBe(true)
})

test("a prompt folded into the message's own turn keeps its answer visible", () => {
  const { session, take } = wrapperTurn(false, "also, what time is it?")
  take(assistant("m2", { type: "text", text: "Passed on; it is noon." }))
  expect(items(session).find((item) => item.kind === "text")?.quiet).not.toBe(true)
})
