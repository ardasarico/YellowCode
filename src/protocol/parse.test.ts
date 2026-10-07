import { expect, test } from "bun:test"
import { parse } from "./parse.ts"

test("classifies known, unknown, and broken lines", () => {
  const known = parse(
    JSON.stringify({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } }),
  )
  const unknown = parse(JSON.stringify({ type: "keep_alive" }))
  const broken = parse(JSON.stringify({ type: "assistant", message: { id: 42 } }))
  const notJson = parse("{oops")

  expect(known.kind).toBe("message")
  expect(unknown).toEqual({ kind: "unknown", key: "keep_alive" })
  expect(broken.kind).toBe("invalid")
  expect(notJson.kind).toBe("invalid")
})

test("a known block with the wrong shape makes the message invalid and names the path", () => {
  const line = JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "m1", content: [{ type: "text", text: 42 }] },
  })
  const parsed = parse(line)

  expect(parsed.kind).toBe("invalid")
  if (parsed.kind === "invalid") expect(parsed.error).toContain("content")
})
