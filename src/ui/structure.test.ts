import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { interruptRequest, userMessage } from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import { createSession } from "../session/session.ts"
import { parseRecording } from "../source/recording.ts"
import { buildRows } from "./structure.ts"

function rowsOf(name: string) {
  const path = join(import.meta.dir, "..", "..", "fixtures", "sessions", `${name}.jsonl`)
  const session = createSession()
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    session.apply(entry.dir, parse(entry.line), entry.t)
  return buildRows(session.state).map((row) => (row.kind === "end" ? `end×${row.turnEnds.length}` : row.kind))
}

test("a turn Claude continues on its own merges into the previous one", () => {
  expect(rowsOf("subagent")).toEqual(["user", "agent", "markdown", "thinking", "markdown", "end×2"])
  expect(rowsOf("agents").filter((row) => row.startsWith("end"))).toEqual(["end×4"])
})

test("a workflow call is one agent row", () => {
  expect(rowsOf("workflow").filter((row) => row === "agent")).toHaveLength(1)
})

test("each shell end is its own row after the Bash rows that started them", () => {
  const rows = rowsOf("shells")
  const ends = rows.flatMap((row, index) => (row === "shell-end" ? [index] : []))
  expect(ends).toHaveLength(3)
  expect(rows.lastIndexOf("tool")).toBeLessThan(ends[0] ?? -1)
  expect(rowsOf("tools")).not.toContain("shell-end")
})

const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0,
  duration_ms: 1,
  usage: { input_tokens: 0, output_tokens: 0 },
}

// A turn with a tool and a message queued during it; `endFirst` ends that turn, then the queued message runs.
function queuedRows(endFirst: (send: (line: string) => void, receive: (message: object) => void) => void) {
  const session = createSession()
  const send = (line: string) => session.apply("out", parse(line), 0)
  const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
  send(userMessage("run it"))
  receive({
    type: "assistant",
    message: { id: "a", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
  })
  send(userMessage("after that", [], "u2"))
  endFirst(send, receive)
  receive({ type: "assistant", message: { id: "b", content: [{ type: "text", text: "the queued one ran" }] } })
  receive({ ...result, user_message_uuids: ["u2"] })
  return buildRows(session.state).map((row) => (row.kind === "end" ? `end×${row.turnEnds.length}` : row.kind))
}

test("an interrupted or failed turn keeps its end row when a queued message runs as the next turn", () => {
  const interrupted = queuedRows((send, receive) => {
    send(interruptRequest("yc-1"))
    receive({ ...result, subtype: "error_during_execution", is_error: true })
  })
  const failed = queuedRows((_, receive) => receive({ ...result, is_error: true, result: "API Error: 529 Overloaded" }))
  for (const rows of [interrupted, failed]) expect(rows).toEqual(["user", "tool", "user", "end×1", "markdown", "end×1"])
})

test("a finished turn keeps its own end row when the turn claude starts next is interrupted or fails", () => {
  const rowsWith = (second: object) => {
    const session = createSession()
    const receive = (message: object) => session.apply("in", parse(JSON.stringify(message)), 0)
    session.apply("out", parse(userMessage("run it")), 0)
    receive({ type: "assistant", message: { id: "a", content: [{ type: "text", text: "done here" }] } })
    receive(result)
    receive({ type: "system", subtype: "status", status: "requesting" })
    session.apply("out", parse(interruptRequest("yc-1")), 0)
    receive({ type: "assistant", message: { id: "b", content: [{ type: "text", text: "a shell ended" }] } })
    receive(second)
    return buildRows(session.state).map((row) => (row.kind === "end" ? `end×${row.turnEnds.length}` : row.kind))
  }
  const ends = ["user", "markdown", "end×1", "markdown", "end×1"]
  expect(rowsWith({ ...result, subtype: "error_during_execution", is_error: true })).toEqual(ends)
  expect(rowsWith({ ...result, is_error: true, result: "API Error: 529 Overloaded" })).toEqual(ends)
})
