import { expect, setSystemTime, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { OWN_ASK, ownAskResult } from "../../protocol/messages.ts"
import { allowAnswers, ownAskReply } from "../../protocol/outgoing.ts"
import { parse } from "../../protocol/parse.ts"
import { answersInResult, askKeys, ownAskProblem } from "../../session/ask.ts"
import type { Ask } from "../../session/types.ts"
import { AskSurface } from "./ask-surface.tsx"
import { alwaysChoice } from "./permission-band.tsx"
import { answersFrom } from "./question-ask.tsx"
import { noteKey } from "./typing.ts"

const ask: Ask = {
  kind: "ask",
  id: "ask-1",
  requestId: "request-1",
  toolUseId: "tool-1",
  toolName: "Bash",
  displayName: "Bash",
  input: { command: "rm -rf old-build" },
  description: "",
  reason: "",
  suggestion: null,
  defaultToNo: false,
  safetyCheck: false,
  status: "pending",
  answers: {},
  notes: {},
  denial: "",
}

test("an ask sends only its first response", async () => {
  const sent: string[] = []
  const setup = await testRender(() => <AskSurface ask={ask} width={80} onAnswer={(_, line) => sent.push(line)} />, {
    width: 80,
    height: 20,
  })
  setup.mockInput.pressKey("1")
  setup.mockInput.pressEnter()
  setup.mockInput.pressEscape()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('"behavior":"allow"')
  setup.renderer.destroy()

  const pressOne = async (severe: Partial<Ask>) => {
    const risky = await testRender(
      () => <AskSurface ask={{ ...ask, ...severe }} width={80} onAnswer={(_, line) => sent.push(line)} />,
      { width: 80, height: 20 },
    )
    risky.mockInput.pressKey("1")
    risky.renderer.destroy()
  }
  await pressOne({ defaultToNo: true })
  await pressOne({ safetyCheck: true })
  expect(sent).toHaveLength(1)
})

test("the first key still typed into the prompt as an ask appears does not answer it", async () => {
  const sent: string[] = []
  setSystemTime(new Date(10_000))
  noteKey()
  const setup = await testRender(() => <AskSurface ask={ask} width={80} onAnswer={(_, line) => sent.push(line)} />, {
    width: 80,
    height: 20,
  })
  // The app notes every key before any other handler sees it.
  const press = (at: number) => {
    setSystemTime(new Date(at))
    noteKey()
    setup.mockInput.pressKey("1")
  }
  press(10_400)
  expect(sent).toHaveLength(0)
  press(10_600)
  expect(sent).toHaveLength(1)
  setSystemTime()
  setup.renderer.destroy()
})

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

test("the always-allow label reads as words and never comes out empty", () => {
  const edits = alwaysChoice({ type: "setMode", mode: "acceptEdits" }, "Write")
  expect(`${edits.before}${edits.subject}${edits.after}`).toBe("Yes, and allow edits for this session")
  expect(alwaysChoice({ type: "setMode", mode: "bypassPermissions" }, "Write").subject).toBe("bypass permissions")
  expect(alwaysChoice({ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "" }] }, "Bash").subject).toBe(
    "Bash",
  )
  expect(alwaysChoice({ type: "addDirectories", directories: [] }, "Read").subject).toBe("Read")
  const read = alwaysChoice(
    { type: "addRules", rules: [{ toolName: "Read", ruleContent: "//tmp/x/**" }], destination: "userSettings" },
    "Read",
  )
  expect(`${read.before}${read.subject}${read.after}`).toBe("Yes, and always allow /tmp/x/** in every project")
  expect(
    alwaysChoice({ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "cat <<EOF\nhi\nEOF" }] }, "Bash")
      .subject,
  ).toBe("cat <<EOF…")
})

test("question answers keep option order, take the typed answer and send only notes of chosen options", () => {
  const options = [{ label: "JSON" }, { label: "TOML" }, { label: "YAML" }]
  const input = {
    questions: [
      { question: "Where?", header: "Storage", options },
      { question: "Which?", header: "Formats", options, multiSelect: true },
    ],
  }
  const state = {
    page: 2,
    focus: [3, 0],
    chosen: [[], [2, 0]],
    own: [" a shared file ", "INI"],
    notes: [
      ["unchosen", "", ""],
      ["keep it small", "unchosen", "strict"],
    ],
    extra: "",
  }
  expect(answersFrom(input, state)).toEqual({
    answers: { "Where?": "a shared file", "Which?": "JSON, YAML, INI" },
    notes: { "Which?": "keep it small; strict" },
  })
})

test("arrows on the own-answer row edit the text instead of switching question", async () => {
  const options = [{ label: "JSON" }]
  const input = {
    questions: [
      { question: "Where?", header: "Storage", options },
      { question: "Which?", header: "Formats", options },
    ],
  }
  const sent: string[] = []
  const setup = await testRender(
    () => (
      <AskSurface
        ask={{ ...ask, toolName: "AskUserQuestion", input }}
        width={80}
        onAnswer={(_, line) => sent.push(line)}
      />
    ),
    { width: 80, height: 30 },
  )
  setup.mockInput.pressArrow("down")
  await setup.mockInput.typeText("ac")
  setup.mockInput.pressArrow("left")
  await setup.mockInput.typeText("b")
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressArrow("right")
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Where?")
  expect(setup.captureCharFrame()).toContain("abc")
  setup.renderer.destroy()
})

test("Enter in a matrix picks the step and goes to the next open row, then sends", async () => {
  const matrix = {
    question: "Keep?",
    header: "File",
    rows: [{ label: "A" }, { label: "B" }, { label: "C" }],
    scale: ["Yes", "No", "Unsure"],
  }
  const sent: string[] = []
  const setup = await testRender(
    () => (
      <AskSurface
        ask={{ ...ask, toolName: OWN_ASK, input: { matrix } }}
        width={80}
        onAnswer={(_, line) => sent.push(line)}
      />
    ),
    { width: 80, height: 30 },
  )
  setup.mockInput.pressKey("2")
  setup.mockInput.pressEnter()
  expect(sent).toHaveLength(0)
  setup.mockInput.pressKey("n")
  await setup.mockInput.typeText("later")
  setup.mockInput.pressEnter()
  setup.mockInput.pressKey("3")
  setup.mockInput.pressEnter()
  expect(sent[0]).toContain('"answers":{"A":"No","B":"No","C":"Unsure"},"annotations":{"C":{"notes":"later"}}')
  setup.renderer.destroy()
})

test("a gallery picks a design with ←→ and keeps its note", async () => {
  const options = ["Dusk", "Petal", "Ember"].map((label) => ({ label, image: `missing/${label}.png` }))
  const questions = [{ question: "Which theme?", header: "Theme", gallery: true, options }]
  const sent: string[] = []
  const setup = await testRender(
    () => (
      <AskSurface
        ask={{ ...ask, toolName: OWN_ASK, input: { questions } }}
        width={100}
        onAnswer={(_, line) => sent.push(line)}
      />
    ),
    { width: 100, height: 40 },
  )
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressKey("n")
  await setup.mockInput.typeText("warm")
  setup.mockInput.pressEnter()
  setup.mockInput.pressEnter()
  expect(sent[0]).toContain('"answers":{"Which theme?":"Petal"},"annotations":{"Which theme?":{"notes":"warm"}}')
  setup.renderer.destroy()
})
