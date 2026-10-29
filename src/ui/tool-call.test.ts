import { expect, test } from "bun:test"
import type { AskOutcome, QuestionPage } from "../agent/ask.ts"
import type { ToolCall } from "../session/types.ts"
import { answerLines, deniedLine, resultSummary, toolLines } from "./tool-call.tsx"

const page = (question: string, header: string): QuestionPage => ({
  key: question,
  header,
  question,
  multi: false,
  gallery: false,
  custom: true,
  options: [],
})

const tool: ToolCall = {
  kind: "tool",
  id: "tool-1",
  name: "AskUserQuestion",
  toolKind: "question",
  title: "AskUserQuestion",
  server: null,
  inputText: "",
  input: {
    questions: [
      { question: "Which storage?", header: "Storage", options: [] },
      { question: "Which formats?", header: "Formats", options: [] },
    ],
  },
  summary: "",
  detail: null,
  background: false,
  status: "done",
  result:
    'The user answered: "Which storage?"="User config file" notes: keep it in ~/.config, "Which formats?"="JSON, TOML". Read the answers carefully.',
  children: [],
  patch: null,
  createdFile: false,
  content: null,
  images: [],
  unchanged: false,
  count: null,
  files: [],
  questions: { pages: [page("Which storage?", "Storage"), page("Which formats?", "Formats")] },
  outcome: {
    status: "answered",
    answers: { "Which storage?": "User config file", "Which formats?": "JSON, TOML" },
    notes: { "Which storage?": "keep it in ~/.config" },
  },
  agent: null,
  taskId: null,
}

test("answers come from the call's outcome when the Ask has none, under each page's header", () => {
  expect(answerLines(tool, null)).toEqual(["Storage: User config file · keep it in ~/.config", "Formats: JSON, TOML"])
})

test("a Read that only says the file is unchanged has no line count", () => {
  const read: ToolCall = {
    ...tool,
    name: "Read",
    toolKind: "read",
    result: "Wasted call — file unchanged since your last Read.",
    unchanged: true,
    count: { n: 0, noun: "line" },
  }
  expect(resultSummary(read)).toBe("unchanged")
  expect(resultSummary({ ...read, result: "     1\tpelican", unchanged: false, count: { n: 1, noun: "line" } })).toBe(
    "1 line",
  )
})

test("a background Bash never shows its launch text", () => {
  const bash = {
    ...tool,
    name: "Bash",
    toolKind: "shell" as const,
    input: { command: "sleep 30", run_in_background: true },
    background: true,
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
    toolKind: "shell" as const,
    input: { command: "sleep 20" },
    status: "done" as const,
    result: "Command was manually backgrounded by user with ID: b2. Output is being written to: /tmp/tasks/b2.output",
    taskId: "b2",
  }
  expect(toolLines(bash, null, { state: "running", background: true }, 0)).toEqual(["running in background · <1s"])
})

test("a question's denial reads the same live and read back from a transcript", () => {
  const denials: [Pick<Extract<AskOutcome, { status: "denied" }>, "why" | "note">, string][] = [
    [{ why: "chat", note: "" }, "back to chat"],
    [{ why: "declined", note: "" }, "denied"],
    [{ why: "declined", note: "use the\nconfig" }, "denied · use the config"],
    [{ why: "unshown", note: "at most 4 options per question" }, "rejected · at most 4 options per question"],
    [{ why: "subagent", note: "" }, "sent back to the main agent"],
  ]
  for (const [denied, line] of denials) {
    expect(deniedLine(denied)).toBe(line)
    const outcome: AskOutcome = { status: "denied", said: "", ...denied }
    expect(toolLines({ ...tool, status: "error", outcome }, null, null, 0)).toEqual([line])
  }
  expect(toolLines({ ...tool, status: "error", outcome: { status: "cancelled" } }, null, null, 0)).toEqual([
    "cancelled",
  ])
  expect(toolLines({ ...tool, status: "error", result: "Bad input", outcome: null }, null, null, 0)).toEqual([
    "Bad input",
  ])
})
