import { expect, test } from "bun:test"
import type { ToolCall } from "../session/types.ts"
import { answerLines, resultSummary } from "./tool-call.tsx"

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
