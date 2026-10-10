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

test("a can_use_tool request with a new suggestion or reason type still parses", () => {
  const request = {
    subtype: "can_use_tool" as const,
    tool_name: "Bash",
    display_name: "Bash",
    input: { command: "rm -rf old-build" },
    description: "Remove old-build directory recursively",
    decision_reason: "rm is dangerous",
    decision_reason_type: "somethingNew",
    default_to_no: true,
    suppress_always_allow_rule: false,
    blocked_path: "/Users/user/project/old-build",
    permission_suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "rm -rf old-build" }],
        behavior: "allow",
        destination: "localSettings",
      },
      { type: "somethingNew", destination: "session", extra: 1 },
    ],
    tool_use_id: "toolu_1",
  }
  const parsed = parse(JSON.stringify({ type: "control_request", request_id: "r1", request }))

  expect(parsed).toEqual({ kind: "message", message: { type: "control_request", request_id: "r1", request } })
})
