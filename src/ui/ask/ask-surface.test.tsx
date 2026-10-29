import { expect, setSystemTime, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { AskOption, AskReply, QuestionPage } from "../../agent/ask.ts"
import type { Ask } from "../../session/types.ts"
import { AskSurface } from "./ask-surface.tsx"
import { choiceOf } from "./permission-band.tsx"
import { answersFrom } from "./question-ask.tsx"
import { noteKey } from "./typing.ts"

const CAPS = { askNote: true }

const option = { label: null, subject: null, note: false, endsTurn: false, mode: null }
const YES: AskOption = { ...option, id: "yes", effect: "allow", lasts: "once" }
const NO: AskOption = { ...option, id: "no", effect: "deny", lasts: "once", note: true }

const choice = (label: string, image: string | null = null) => ({ label, description: null, preview: null, image })
const page = (question: string, header: string, options: string[], more: Partial<QuestionPage> = {}): QuestionPage => ({
  key: question,
  header,
  question,
  multi: false,
  gallery: false,
  custom: true,
  options: options.map((label) => choice(label)),
  ...more,
})

const ask: Ask = {
  kind: "ask",
  id: "ask-1",
  requestId: "request-1",
  toolUseId: "tool-1",
  toolName: "Bash",
  toolKind: "shell",
  server: null,
  displayName: "Bash",
  input: { command: "rm -rf old-build" },
  target: "rm -rf old-build",
  writes: [],
  description: "",
  reason: "",
  options: [YES, NO],
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

test("an ask sends only its first response", async () => {
  const sent: AskReply[] = []
  const setup = await testRender(
    () => <AskSurface caps={CAPS} agent="Claude" ask={ask} width={80} onAnswer={(_, reply) => sent.push(reply)} />,
    {
      width: 80,
      height: 20,
    },
  )
  setup.mockInput.pressKey("1")
  setup.mockInput.pressEnter()
  setup.mockInput.pressEscape()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toEqual({ type: "option", option: "yes", note: null })
  setup.renderer.destroy()

  const pressOne = async (severe: Partial<Ask>) => {
    const risky = await testRender(
      () => (
        <AskSurface
          caps={CAPS}
          agent="Claude"
          ask={{ ...ask, ...severe }}
          width={80}
          onAnswer={(_, reply) => sent.push(reply)}
        />
      ),
      { width: 80, height: 20 },
    )
    risky.mockInput.pressKey("1")
    risky.renderer.destroy()
  }
  await pressOne({ defaultToNo: true })
  await pressOne({ safetyCheck: true })
  expect(sent).toHaveLength(1)
})

test("a severe ask starts on the no that lasts once, wherever it sits", async () => {
  const sent: AskReply[] = []
  const always: AskOption = { ...NO, id: "never", lasts: "everywhere", note: false }
  const setup = await testRender(
    () => (
      <AskSurface
        caps={CAPS}
        agent="Claude"
        ask={{ ...ask, defaultToNo: true, options: [YES, NO, always] }}
        width={80}
        onAnswer={(_, reply) => sent.push(reply)}
      />
    ),
    { width: 80, height: 20 },
  )
  setup.mockInput.pressEnter()
  expect(sent).toEqual([{ type: "option", option: "no", note: null }])
  setup.renderer.destroy()
})

test("the first key still typed into the prompt as an ask appears does not answer it", async () => {
  const sent: AskReply[] = []
  setSystemTime(new Date(10_000))
  noteKey()
  const setup = await testRender(
    () => <AskSurface caps={CAPS} agent="Claude" ask={ask} width={80} onAnswer={(_, reply) => sent.push(reply)} />,
    {
      width: 80,
      height: 20,
    },
  )
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

const words = (more: Partial<AskOption>) => {
  const shown = choiceOf({ ...YES, ...more })
  return `${shown.before}${shown.subject}${shown.after}`
}

test("an option without a label reads as words, with what a lasting one covers and for how long", () => {
  expect(words({})).toBe("Yes")
  expect(words({ effect: "deny" })).toBe("No")
  expect(words({ lasts: "session", subject: "edits" })).toBe("Yes, and allow edits for this session")
  expect(words({ lasts: "everywhere", subject: "/tmp/x/**" })).toBe("Yes, and always allow /tmp/x/** in every project")
  expect(words({ lasts: "project", subject: "cat <<EOF\nhi\nEOF" })).toBe("Yes, and always allow cat <<EOF… here")
  expect(words({ lasts: "session", label: "Allow for this chat" })).toBe("Allow for this chat")
})

test("question answers keep option order, take the typed answer and send only notes of chosen options", () => {
  const options = ["JSON", "TOML", "YAML"]
  const pages = [page("Where?", "Storage", options), page("Which?", "Formats", options, { multi: true })]
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
  expect(answersFrom(pages, state)).toEqual({
    values: { "Where?": ["a shared file"], "Which?": ["JSON", "YAML", "INI"] },
    fields: {},
    notes: { "Which?": "keep it small; strict" },
    note: "",
  })
})

test("arrows on the own-answer row edit the text instead of switching question", async () => {
  const questions = { pages: [page("Where?", "Storage", ["JSON"]), page("Which?", "Formats", ["JSON"])] }
  const sent: AskReply[] = []
  const setup = await testRender(
    () => (
      <AskSurface
        caps={CAPS}
        agent="Claude"
        ask={{ ...ask, toolName: "AskUserQuestion", toolKind: "question", options: [], questions }}
        width={80}
        onAnswer={(_, reply) => sent.push(reply)}
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
  const matrix = { question: "Keep?", header: "File", rows: ["A", "B", "C"], scale: ["Yes", "No", "Unsure"] }
  const sent: AskReply[] = []
  const setup = await testRender(
    () => (
      <AskSurface
        caps={CAPS}
        agent="Claude"
        ask={{ ...ask, toolName: "ask", toolKind: "question", options: [], questions: { matrix } }}
        width={80}
        onAnswer={(_, reply) => sent.push(reply)}
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
  expect(sent[0]).toEqual({
    type: "answers",
    answers: { values: { A: ["No"], B: ["No"], C: ["Unsure"] }, fields: {}, notes: { C: "later" }, note: "" },
  })
  setup.renderer.destroy()
})

test("a gallery picks a design with ←→ and keeps its note", async () => {
  const options = ["Dusk", "Petal", "Ember"].map((label) => choice(label, `missing/${label}.png`))
  const questions = { pages: [{ ...page("Which theme?", "Theme", []), gallery: true, options }] }
  const sent: AskReply[] = []
  const setup = await testRender(
    () => (
      <AskSurface
        caps={CAPS}
        agent="Claude"
        ask={{ ...ask, toolName: "ask", toolKind: "question", options: [], questions }}
        width={100}
        onAnswer={(_, reply) => sent.push(reply)}
      />
    ),
    { width: 100, height: 40 },
  )
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressKey("n")
  await setup.mockInput.typeText("warm")
  setup.mockInput.pressEnter()
  setup.mockInput.pressEnter()
  expect(sent[0]).toEqual({
    type: "answers",
    answers: { values: { "Which theme?": ["Petal"] }, fields: {}, notes: { "Which theme?": "warm" }, note: "" },
  })
  setup.renderer.destroy()
})
