import { expect, test } from "bun:test"
import type { AskOption } from "../../agent/ask.ts"
import { OWN_ASK, ownAskResult, type PermissionUpdate } from "../../protocol/messages.ts"
import {
  allowAnswers,
  allowTool,
  answerQuestions,
  DECLINED_WITH_NOTE,
  denyTool,
  ownAskReply,
  QUESTION_TO_CHAT,
  TOOL_DECLINED,
} from "../../protocol/outgoing.ts"
import { parse } from "../../protocol/parse.ts"
import { answersInResult, askKeys } from "./ask-input.ts"
import type { Ask } from "../../session/types.ts"
import { answerLine } from "./answers.ts"

const rule: PermissionUpdate = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "bun test" }],
  destination: "localSettings",
}

const option = { label: null, subject: null, note: false, endsTurn: false, mode: null }
const YES: AskOption = { ...option, id: "yes", effect: "allow", lasts: "once" }
const ALWAYS: AskOption = { ...option, id: "always-0", effect: "allow", lasts: "project", grant: rule }
const NO: AskOption = { ...option, id: "no", effect: "deny", lasts: "once", note: true }

const ask: Ask = {
  kind: "ask",
  id: "ask-r",
  requestId: "r",
  toolUseId: "t",
  toolName: "Bash",
  toolKind: "shell",
  server: null,
  displayName: "Bash",
  input: { command: "bun test" },
  target: "bun test",
  writes: [],
  description: "",
  reason: "",
  options: [YES, ALWAYS, NO],
  questions: null,
  plan: null,
  defaultToNo: false,
  safetyCheck: false,
  status: "pending",
  answers: {},
  notes: {},
  denial: "",
  why: null,
  note: "",
}

test("a reply goes out as the line the ask views used to build", () => {
  const { input } = ask
  expect(answerLine(ask, { type: "option", option: "yes", note: null })).toBe(allowTool("r", input))
  expect(answerLine(ask, { type: "option", option: "always-0", note: null })).toBe(allowTool("r", input, [rule]))
  expect(answerLine(ask, { type: "option", option: "no", note: null })).toBe(denyTool("r", TOOL_DECLINED))
  expect(answerLine(ask, { type: "option", option: "no", note: "use rg" })).toBe(
    denyTool("r", `${DECLINED_WITH_NOTE}use rg`),
  )
  expect(answerLine(ask, { type: "declined", chat: true })).toBe(denyTool("r", QUESTION_TO_CHAT))

  const pages = { questions: [{ question: "Which?", header: "Format", options: [{ label: "A" }, { label: "B" }] }] }
  const question = { ...ask, toolName: "AskUserQuestion", toolKind: "question" as const, input: pages }
  const answers = { values: { "Which?": ["A", "B"] }, fields: {}, notes: { "Which?": "both" }, note: "soon" }
  expect(answerLine(question, { type: "answers", answers })).toBe(
    answerQuestions("r", pages, { "Which?": "A, B" }, { "Which?": "both" }, "soon"),
  )
  const matrix = { question: "Keep?", header: "File", rows: [{ label: "A" }, { label: "B" }], scale: ["Yes", "No"] }
  const own = { ...ask, toolName: OWN_ASK, toolKind: "question" as const, input: { matrix } }
  const steps = { values: { A: ["Yes"], B: ["No"] }, fields: {}, notes: { B: "later" }, note: "" }
  expect(answerLine(own, { type: "answers", answers: steps })).toBe(
    allowAnswers("r", { matrix }, { A: "Yes", B: "No" }, { B: "later" }),
  )
})

const numbered = (count: number) => Array.from({ length: count }, (_, i) => ({ label: `Option ${i + 1}` }))

const sendOwn = (input: object, answers: Record<string, string>, notes: Record<string, string>) => {
  const line = parse(ownAskReply({ requestId: "r", input }, 7, allowAnswers("r", input, answers, notes)))
  const reply = line.kind === "message" && line.message.type === "control_response" ? line.message.response : null
  const text = ownAskResult.parse(reply?.response).mcp_response.result.content[0]?.text ?? ""
  expect(answersInResult(text, askKeys(input))).toEqual({ answers, notes })
  return text
}

test("an own ask's answer reaches Claude in stock's words and reads back the same", () => {
  const questions = [
    { question: "Where?", header: "Storage", options: numbered(2) },
    { question: "Which?", header: "Format", options: numbered(2) },
  ]
  expect(sendOwn({ questions }, { "Which?": "TOML", "Where?": "Here" }, { "Where?": 'small. And fast, "ok"' })).toBe(
    'Your questions have been answered: "Where?"="Here" notes: small. And fast, "ok", "Which?"="TOML". You can ' +
      "now continue with these answers in mind.",
  )
  const matrix = { question: "Keep?", header: "File", rows: [{ label: "A" }, { label: "B" }], scale: ["Yes", "No"] }
  expect(sendOwn({ matrix }, { A: "Yes", B: "No" }, { B: "later" })).toBe(
    'Your questions have been answered: "Keep?": "A"="Yes", "B"="No" notes: later. You can now continue with ' +
      "these answers in mind.",
  )
})

test("quotes in a question, a row or an answer keep every answer under its own key", () => {
  const questions = [
    { question: 'Use "strict" mode?', header: "Mode", options: numbered(2) },
    { question: "Which?", header: "Format", options: numbered(2) },
  ]
  sendOwn({ questions }, { 'Use "strict" mode?': 'Yes, "always"', "Which?": 'a", "b' }, { "Which?": 'it said "no"' })
  const matrix = { question: "Keep?", header: "File", rows: [{ label: 'The "A" file' }, { label: "B" }], scale: ["x"] }
  sendOwn({ matrix }, { 'The "A" file': 'Yes, "b"="c"', B: '"No"' }, {})
})
