import { expect, test } from "bun:test"
import type { ToolCall } from "../session/types.ts"
import { answerLines, resultSummary, toolLines } from "./tool-call.tsx"

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
  for (const shell of [null, { state: "running" as const }, { state: "completed" as const }])
    expect(toolLines(bash, null, shell, 0).join()).not.toContain("Command running in background")
})
