import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "../protocol/parse.ts"
import { parseRecording } from "../source/recording.ts"
import { createSession } from "./session.ts"
import type { Item } from "./types.ts"

function replay(name: string) {
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", `${name}.jsonl`)
  const session = createSession()
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries) session.apply(entry.dir, parse(entry.line))
  return session
}

function feed(...messages: object[]) {
  const session = createSession()
  for (const message of messages) session.apply("in", parse(JSON.stringify(message)))
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
  expect(all.some((item) => item.kind === "permission")).toBe(true)
  expect(all.filter((item) => item.kind === "permission" && item.decision !== "allowed")).toEqual([])
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

  session.apply("in", parse(JSON.stringify(result)))
  expect(streaming(session)).toEqual([])
  expect(items(session).some((item) => item.kind === "turn-end")).toBe(true)
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
  expect(images[0]?.data.length).toBeGreaterThan(0)
})

test("file edits carry their patch", () => {
  const edit = items(replay("tools")).find((item) => item.kind === "tool" && item.name === "Edit")
  expect(edit?.kind === "tool" && edit.patch).toHaveLength(1)
  const write = items(replay("permission")).find((item) => item.kind === "tool" && item.name === "Write")
  expect(write).toMatchObject({ createdFile: true })
})

test("an Agent call carries the agent's name and task", () => {
  const agent = items(replay("subagent")).find((item) => item.kind === "tool" && item.name === "Agent")
  expect(agent).toMatchObject({ agent: { name: "general-purpose", task: "List files in working directory" } })
})

test("an interrupted turn starts with its model and ends interrupted", () => {
  const all = items(replay("error"))
  const ends = all.filter((item) => item.kind === "turn-end")
  expect(ends.map((item) => item.kind === "turn-end" && item.interrupted)).toEqual([false, true])
  const starts = all.filter((item) => item.kind === "turn-start")
  expect(starts).toHaveLength(2)
  expect(starts.every((item) => item.kind === "turn-start" && item.model.length > 0)).toBe(true)
})

test("thinking text fills from the stream", () => {
  const thinking = items(replay("thinking")).filter((item) => item.kind === "thinking")
  expect(thinking.length).toBeGreaterThan(0)
  expect(thinking.every((item) => item.kind === "thinking" && item.text.length > 0)).toBe(true)
})
