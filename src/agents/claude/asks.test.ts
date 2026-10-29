import { expect, test } from "bun:test"
import { OWN_ASK } from "../../protocol/messages.ts"
import { mcpToolError, NOT_SHOWN } from "../../protocol/outgoing.ts"
import { parse } from "../../protocol/parse.ts"
import { createSession } from "../../session/session.ts"
import { ownAskProblem } from "./ask-input.ts"
import { subjectOf } from "./asks.ts"
import { resultOutcome } from "./outcome.ts"
import { feed } from "./translate.ts"

const numbered = (count: number) => Array.from({ length: count }, (_, i) => ({ label: `Option ${i + 1}` }))
const problem = (input: unknown, toolName = OWN_ASK) => ownAskProblem({ toolName, input })

test("our own ask goes back to Claude with what to fix; stock asks are left alone", () => {
  const five = { questions: [{ question: "Which?", header: "Pick", options: numbered(5) }] }
  expect(problem(five)).toBe("at most 4 options per question")
  expect(problem(five, "AskUserQuestion")).toBeNull()
  const twice = { questions: [0, 1].map(() => ({ question: "Same?", header: "Pick", options: numbered(2) })) }
  expect(problem(twice)).toBe("questions must be unique")
  const rows = [{ label: "A" }, { label: "A" }]
  const matrix = { matrix: { question: "Keep?", header: "File", rows, scale: ["Yes", "No"] } }
  expect(problem(matrix)).toBe("row labels must be unique")
  const fine = { questions: [{ question: "Which?", header: "Pick", options: numbered(4) }] }
  expect(problem(fine)).toBeNull()
  expect(problem({})).toBe("give exactly one of questions or matrix")
  expect(problem({ ...fine, ...matrix })).toBe("give exactly one of questions or matrix")
  expect(problem({ questions: [{ question: "Which?", options: numbered(2) }] })).toStartWith("questions.0.header:")
})

test("a broken own ask never opens", () => {
  const session = createSession()
  const line = (dir: "in" | "out", message: object | string) =>
    feed(session, dir, parse(typeof message === "string" ? message : JSON.stringify(message)), 0)
  const input = { questions: [] }
  const toolUse = { type: "tool_use", id: "t1", name: OWN_ASK, input }
  line("in", { type: "assistant", message: { id: "a", content: [toolUse] } })
  const params = { name: "ask", arguments: input, _meta: { "claudecode/toolUseId": "t1" } }
  const message = { jsonrpc: "2.0", id: 3, method: "tools/call", params }
  const request = { subtype: "mcp_message", server_name: "yellowcode", message }
  line("in", { type: "control_request", request_id: "r1", request })
  line("out", mcpToolError("r1", 3, `${NOT_SHOWN}at least 1 question.`))
  const kinds = session.state.items.map((id) => session.state.byId[id]?.kind)
  expect(kinds).toEqual(["tool"])
})

const ruleFor = (toolName: string) => subjectOf({ type: "addRules", rules: [{ toolName }] }, "Bash")

test("what a lasting yes covers reads as words and never comes out empty", () => {
  expect(subjectOf({ type: "setMode", mode: "acceptEdits" }, "Write")).toBe("edits")
  expect(subjectOf({ type: "setMode", mode: "bypassPermissions" }, "Write")).toBe("bypass permissions")
  expect(subjectOf({ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "" }] }, "Bash")).toBe("Bash")
  expect(subjectOf({ type: "addDirectories", directories: [] }, "Read")).toBe("Read")
  expect(["mcp__docs__find", "mcp__my_db__run__query", "mcp__echo__"].map(ruleFor)).toEqual([
    "docs/find",
    "my_db/run__query",
    "mcp__echo__",
  ])
  expect(subjectOf({ type: "addRules", rules: [{ toolName: "Read", ruleContent: "//tmp/x/**" }] }, "Read")).toBe(
    "/tmp/x/**",
  )
})

test("a stock question's answers read back from its result, and a failed call is no answer", () => {
  const input = {
    questions: ["Which storage?", "Which formats?"].map((question) => ({ question, header: "", options: [] })),
  }
  expect(
    resultOutcome(
      input,
      "done",
      'The user answered: "Which storage?"="User config file" notes: keep it in ~/.config, "Which formats?"="JSON, ' +
        'TOML". Read the answers carefully.',
    ),
  ).toEqual({
    status: "answered",
    answers: { "Which storage?": "User config file", "Which formats?": "JSON, TOML" },
    notes: { "Which storage?": "keep it in ~/.config" },
  })
  expect(
    resultOutcome(
      input,
      "done",
      'The user answered: "Which storage?"="User config file", "Which formats?"="JSON" notes: json note\nAdditional ' +
        "note: two envs. Read the answers carefully.",
    ),
  ).toEqual({
    status: "answered",
    answers: { "Which storage?": "User config file", "Which formats?": "JSON" },
    notes: { "Which formats?": "json note\nAdditional note: two envs" },
  })
  expect(resultOutcome(input, "error", "InputValidationError: questions is required")).toBeNull()
  expect(resultOutcome(input, "error", `${NOT_SHOWN}at least 1 question.`)).toEqual({
    status: "denied",
    said: `${NOT_SHOWN}at least 1 question.`,
    why: "unshown",
    note: "at least 1 question",
  })
})
