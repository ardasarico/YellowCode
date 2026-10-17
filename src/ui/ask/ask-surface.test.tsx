import { expect, setSystemTime, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { OWN_ASK } from "../../protocol/messages.ts"
import { ownAskRejection } from "../../session/ask.ts"
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

  const risky = await testRender(
    () => <AskSurface ask={{ ...ask, defaultToNo: true }} width={80} onAnswer={(_, line) => sent.push(line)} />,
    { width: 80, height: 20 },
  )
  risky.mockInput.pressKey("1")
  expect(sent).toHaveLength(1)
  risky.renderer.destroy()
})

test("the first key still typed into the prompt as an ask appears does not answer it", async () => {
  const sent: string[] = []
  setSystemTime(new Date(10_000))
  noteKey()
  const setup = await testRender(() => <AskSurface ask={ask} width={80} onAnswer={(_, line) => sent.push(line)} />, {
    width: 80,
    height: 20,
  })
  setSystemTime(new Date(10_400))
  setup.mockInput.pressKey("1")
  expect(sent).toHaveLength(0)
  setSystemTime(new Date(10_600))
  setup.mockInput.pressKey("1")
  expect(sent).toHaveLength(1)
  setSystemTime()
  setup.renderer.destroy()
})

const ownAsk = (tool_name: string, input: unknown) => ({
  type: "control_request" as const,
  request_id: "request-1",
  request: { subtype: "can_use_tool" as const, tool_name, tool_use_id: "tool-1", input },
})
const numbered = (count: number) => Array.from({ length: count }, (_, i) => ({ label: `Option ${i + 1}` }))

test("our own ask goes back to Claude with what to fix; stock asks are left alone", () => {
  const five = { questions: [{ question: "Which?", header: "Pick", options: numbered(5) }] }
  expect(ownAskRejection(ownAsk(OWN_ASK, five))).toContain('"behavior":"deny","message":"Not shown to the user')
  expect(ownAskRejection(ownAsk(OWN_ASK, five))).toContain("at most 4 options per question")
  expect(ownAskRejection(ownAsk("AskUserQuestion", five))).toBeNull()
  const twice = { questions: [0, 1].map(() => ({ question: "Same?", header: "Pick", options: numbered(2) })) }
  expect(ownAskRejection(ownAsk(OWN_ASK, twice))).toContain("questions must be unique")
  const rows = [{ label: "A" }, { label: "A" }]
  const matrix = { matrix: { question: "Keep?", header: "File", rows, scale: ["Yes", "No"] } }
  expect(ownAskRejection(ownAsk(OWN_ASK, matrix))).toContain("row labels must be unique")
  const fine = { questions: [{ question: "Which?", header: "Pick", options: numbered(4) }] }
  expect(ownAskRejection(ownAsk(OWN_ASK, fine))).toBeNull()
})

test("the always-allow label reads as words and never comes out empty", () => {
  const edits = alwaysChoice({ type: "setMode", mode: "acceptEdits" }, "Write")
  expect(`${edits.before}${edits.subject}${edits.after}`).toBe("Yes, and allow edits for this session")
  expect(alwaysChoice({ type: "setMode", mode: "bypassPermissions" }, "Write").subject).toBe("bypass permissions")
  expect(alwaysChoice({ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "" }] }, "Bash").subject).toBe(
    "Bash",
  )
  expect(alwaysChoice({ type: "addDirectories", directories: [] }, "Read").subject).toBe("Read")
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

test("a long option description wraps under its label", async () => {
  const description = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")
  const input = { questions: [{ question: "Where?", header: "Storage", options: [{ label: "Env", description }] }] }
  const setup = await testRender(
    () => (
      <box flexDirection="column">
        <AskSurface ask={{ ...ask, toolName: "AskUserQuestion", input }} width={40} onAnswer={() => {}} />
      </box>
    ),
    { width: 40, height: 20 },
  )
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("w29")
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
