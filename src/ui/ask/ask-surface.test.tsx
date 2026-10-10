import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Ask } from "../../session/types.ts"
import { AskSurface } from "./ask-surface.tsx"
import { alwaysChoice } from "./permission-band.tsx"
import { answersFrom } from "./question-ask.tsx"

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
