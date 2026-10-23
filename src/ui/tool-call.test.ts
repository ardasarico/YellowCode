import { expect, test } from "bun:test"
import { OWN_ASK } from "../protocol/messages.ts"
import { NOT_SHOWN, QUESTION_TO_CHAT, SUBAGENT_ASK, TOOL_DECLINED } from "../protocol/outgoing.ts"
import type { ToolCall } from "../session/types.ts"
import { answerLines, deniedLine, resultSummary, toolLines } from "./tool-call.tsx"

const tool: ToolCall = {
  kind: "tool",
  id: "tool-1",
  name: "AskUserQuestion",
  inputText: "",
  input: {
    questions: [
      { question: "Which storage?", header: "Storage", options: [] },
      { question: "Which formats?", header: "Formats", options: [] },
    ],
  },
  summary: "",
  status: "done",
  result:
    'The user answered: "Which storage?"="User config file" notes: keep it in ~/.config, "Which formats?"="JSON, TOML". Read the answers carefully.',
  children: [],
  patch: null,
  createdFile: false,
  images: [],
  unchanged: false,
  agent: null,
  taskId: null,
}

test("answers read from the tool result when the Ask has none", () => {
  expect(answerLines(tool, null)).toEqual(["Storage: User config file · keep it in ~/.config", "Formats: JSON, TOML"])
  const withExtra = {
    ...tool,
    result:
      'The user answered: "Which storage?"="User config file", "Which formats?"="JSON" notes: json note\nAdditional note: two envs. Read the answers carefully.',
  }
  expect(answerLines(withExtra, null)).toEqual([
    "Storage: User config file",
    "Formats: JSON · json note Additional note: two envs",
  ])
})

test("a Read that only says the file is unchanged has no line count", () => {
  const read = { ...tool, name: "Read", result: "Wasted call — file unchanged since your last Read.", unchanged: true }
  expect(resultSummary(read)).toBe("unchanged")
  expect(resultSummary({ ...read, result: "     1\tpelican", unchanged: false })).toBe("1 line")
})

test("a background Bash never shows its launch text", () => {
  const bash = {
    ...tool,
    name: "Bash",
    input: { command: "sleep 30", run_in_background: true },
    result: "Command running in background with ID: b1x7k2. Output is being written to: /tmp/tasks/b1x7k2.output",
    taskId: "b1x7k2",
  }
  for (const state of ["running", "completed"] as const)
    expect(toolLines(bash, null, { state, background: true }, 0).join()).not.toContain("Command running in background")
  expect(toolLines(bash, null, null, 0)).toEqual(["in background"])
})

test("a Bash sent to the background with Ctrl+B follows its shell", () => {
  const bash = {
    ...tool,
    name: "Bash",
    input: { command: "sleep 20" },
    status: "done" as const,
    result: "Command was manually backgrounded by user with ID: b2. Output is being written to: /tmp/tasks/b2.output",
    taskId: "b2",
  }
  expect(toolLines(bash, null, { state: "running", background: true }, 0)).toEqual(["running in background · <1s"])
})

test("a question's denial reads the same live and read back from a transcript", () => {
  const denials: [string, string][] = [
    [QUESTION_TO_CHAT, "back to chat"],
    [TOOL_DECLINED, "denied"],
    [`${NOT_SHOWN}at most 4 options per question.`, "rejected · at most 4 options per question"],
    [SUBAGENT_ASK, "sent back to the main agent"],
  ]
  for (const [denial, line] of denials) {
    expect(deniedLine({ denial })).toBe(line)
    expect(toolLines({ ...tool, name: OWN_ASK, status: "error", result: denial }, null, null, 0)).toEqual([line])
  }
  const interrupted = "The user doesn't want to proceed with this tool use. The tool use was rejected."
  expect(toolLines({ ...tool, status: "error", result: interrupted }, null, null, 0)).toEqual(["cancelled"])
})
