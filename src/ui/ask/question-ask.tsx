import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, Index, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { AskUserQuestionInput } from "../../protocol/messages.ts"
import { answerQuestions, denyTool, QUESTION_DECLINED } from "../../protocol/outgoing.ts"
import { yellow } from "../../theme/brand.ts"
import { theme } from "../../theme/theme.ts"
import { AskScroll } from "./ask-scroll.tsx"
import { fitHints, pageLabels } from "./fit.ts"
import type { AskViewProps } from "./ask-surface.tsx"

const HINTS: [string, string][] = [
  ["←→", "question"],
  ["↑↓", "option"],
  ["space", "pick"],
  ["enter", "select"],
  ["n", "note"],
  ["esc", "cancel"],
]
const NOTE_HINTS = "enter save · esc drop"
const SUBMIT_HINTS = "←→ question · enter submit · esc cancel"
const SHORT_SUBMIT_HINTS = "←→ · enter · esc"

// Only the keys that act here: ←→ needs pages, and on the own-answer row n and space type into the input.
function questionHints(paged: boolean, ownRow: boolean, width: number): string {
  const keys = HINTS.filter(([key]) => (paged || key !== "←→") && (!ownRow || (key !== "n" && key !== "space")))
  const full = keys.map((hint) => hint.join(" ")).join(" · ")
  const short = keys.map(([key]) => key).join(" · ")
  return fitHints(full, short, width)
}

type Question = AskUserQuestionInput["questions"][number]

// `page` runs past the last question to Submit. Per question, `focus` is the cursor row (the options' length is
// the own-answer row), `chosen` the marked options (at most one for a radio), `own` the typed answer, and `notes`
// one note per option. `extra` is the additional note on the Submit page.
export type QuestionState = {
  page: number
  focus: number[]
  chosen: number[][]
  own: string[]
  notes: string[][]
  extra: string
}

const chosenOf = (state: QuestionState, index: number) => (state.chosen[index] ?? []).toSorted((a, b) => a - b)

// A radio's marked option wins over the typed answer; a multi-select takes both.
function answerFor(question: Question, state: QuestionState, index: number): string {
  const own = state.own[index]?.trim() ?? ""
  const labels = chosenOf(state, index).map((option) => question.options[option]?.label ?? "")
  if (!question.multiSelect) return labels[0] ?? own
  return [...labels, own].filter((part) => part !== "").join(", ")
}

// Only the notes of chosen options are sent.
function notesFor(state: QuestionState, index: number): string {
  return chosenOf(state, index)
    .map((option) => state.notes[index]?.[option] ?? "")
    .filter((note) => note !== "")
    .join("; ")
}

export function answersFrom(
  input: AskUserQuestionInput,
  state: QuestionState,
): { answers: Record<string, string>; notes: Record<string, string> } {
  const answers: Record<string, string> = {}
  const notes: Record<string, string> = {}
  input.questions.forEach((question, index) => {
    answers[question.question] = answerFor(question, state, index)
    const note = notesFor(state, index)
    if (note) notes[question.question] = note
  })
  return { answers, notes }
}

function mark(question: Question, on: boolean): string {
  if (question.multiSelect) return on ? "■" : "□"
  return on ? "◉" : "○"
}

function Rule(props: { width: number; color: typeof theme.frame }) {
  return (
    <text fg={props.color} wrapMode="none" flexShrink={0}>
      {"─".repeat(props.width)}
    </text>
  )
}

function PageBar(props: { questions: Question[]; page: number; width: number }) {
  const pages = () =>
    pageLabels(
      props.questions.map((question) => question.header),
      props.width,
    )
  return (
    <text wrapMode="none" flexShrink={0}>
      <span>{"  "}</span>
      <Index each={pages()}>
        {(page, index) => (
          <>
            <span style={{ fg: theme.frame }}>{index > 0 ? "  │  " : ""}</span>
            <span style={{ fg: index === props.page ? theme.text : theme.muted, bold: index === props.page }}>
              {page()}
            </span>
          </>
        )}
      </Index>
    </text>
  )
}

export function QuestionAsk(props: AskViewProps & { input: AskUserQuestionInput }) {
  const questions = () => props.input.questions
  const paged = () => questions().length > 1
  const [state, setState] = createStore<QuestionState>(
    untrack(() => ({
      page: 0,
      focus: questions().map(() => 0),
      chosen: questions().map(() => []),
      own: questions().map(() => ""),
      notes: questions().map((current) => current.options.map(() => "")),
      extra: "",
    })),
  )
  const [noting, setNoting] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const question = () => questions()[state.page]
  const focus = () => state.focus[state.page] ?? 0
  const onOwnRow = () => focus() === question()?.options.length
  const scrollTarget = () => {
    if (noting()) return "note"
    if (!question()) return "extra-row"
    return onOwnRow() ? "own-row" : `option-${focus()}`
  }
  const fromTop = () => !noting() && (!question() || focus() === 0)

  // Submit sends nothing while a question has no answer; it opens that question instead.
  const submit = () => {
    const missing = questions().findIndex((current, index) => answerFor(current, state, index) === "")
    if (missing >= 0) return setState("page", missing)
    const { answers, notes } = answersFrom(props.input, state)
    props.onAnswer(answerQuestions(props.ask.requestId, props.input, answers, notes, state.extra.trim()))
  }
  const next = () => (paged() ? setState("page", state.page + 1) : submit())
  const choose = (option: number) => {
    if (!question()?.multiSelect) return setState("chosen", state.page, [option])
    setState("chosen", state.page, (chosen) =>
      chosen.includes(option) ? chosen.filter((other) => other !== option) : [...chosen, option],
    )
  }

  // On an option a radio takes the focused option; a multi-select keeps its marks, or takes the focused option when
  // nothing is marked. On the own-answer row a radio takes the typed text instead of its mark.
  const select = () => {
    const current = question()
    if (!current) return submit()
    const nothingMarked = (state.chosen[state.page] ?? []).length === 0
    if (onOwnRow()) {
      const typed = (state.own[state.page]?.trim() ?? "") !== ""
      if (!typed && nothingMarked) return
      if (typed && !current.multiSelect) setState("chosen", state.page, [])
    } else if (!current.multiSelect || nothingMarked) choose(focus())
    next()
  }

  const pick = (option: number) => {
    const current = question()
    if (!current || option >= current.options.length) return
    setState("focus", state.page, option)
    choose(option)
    if (!current.multiSelect) next()
  }

  const typeOwn = (text: string) => {
    setState("own", state.page, text)
    if (text.trim() !== "" && !question()?.multiSelect) setState("chosen", state.page, [])
  }

  const openNote = () => {
    setDraft(state.notes[state.page]?.[focus()] ?? "")
    setNoting(true)
  }
  const saveNote = () => {
    setState("notes", state.page, focus(), draft().trim())
    setNoting(false)
  }

  // On the own-answer row and on Submit the focused input takes the keys this handler leaves alone, so they type there.
  useKeyboard((key) => {
    if (props.answered) return
    if (noting()) {
      if (key.name === "escape") setNoting(false)
      else if (key.name === "return") saveNote()
      else return
      key.preventDefault()
      return
    }
    const current = question()
    const last = current?.options.length ?? 0
    if (key.name === "escape") props.onAnswer(denyTool(props.ask.requestId, QUESTION_DECLINED))
    else if (paged() && (key.name === "left" || key.name === "right")) {
      const step = key.name === "left" ? -1 : 1
      setState("page", (page) => Math.min(questions().length, Math.max(0, page + step)))
    } else if (current && key.name === "up") setState("focus", state.page, (row) => Math.max(0, row - 1))
    else if (current && key.name === "down") setState("focus", state.page, (row) => Math.min(last, row + 1))
    else if (key.name === "return") select()
    else if (!current || onOwnRow() || key.ctrl || key.meta) return
    else if (key.name === "space") choose(focus())
    else if (key.name === "n") openNote()
    else if (/^[1-9]$/.test(key.name)) pick(Number(key.name) - 1)
    else return
    key.preventDefault()
  })

  // The root takes no width: a box with an explicit width does not shrink in height under its parent's maxHeight.
  return (
    <box flexDirection="column" flexShrink={1}>
      <Rule width={props.width} color={theme.frame} />
      <Show when={paged()}>
        <PageBar questions={questions()} page={state.page} width={props.width} />
        <Rule width={props.width} color={theme.dimFrame} />
      </Show>
      <AskScroll focus={scrollTarget()} fromTop={fromTop()} scope={state.page}>
        <Show
          when={question()}
          fallback={
            <box flexDirection="column" marginTop={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Review your answers
              </text>
              <box flexDirection="column" marginTop={1} marginBottom={1}>
                <Index each={questions()}>
                  {(current, index) => {
                    const answer = () => answerFor(current(), state, index)
                    const note = () => notesFor(state, index)
                    return (
                      <text wrapMode="word">
                        <span style={{ fg: theme.muted }}>{`${current().header}: `}</span>
                        <span style={{ fg: answer() ? theme.text : theme.faint }}>{answer() || "no answer"}</span>
                        <span style={{ fg: theme.accent }}>{note() ? ` · ${note()}` : ""}</span>
                      </text>
                    )
                  }}
                </Index>
              </box>
              <box id="extra-row" flexDirection="row">
                <text fg={yellow(theme.rgb)} flexShrink={0}>
                  {"❯ "}
                </text>
                <input
                  focused
                  flexGrow={1}
                  value={state.extra}
                  onInput={(text: string) => setState("extra", text)}
                  placeholder="add a note for Claude…"
                  placeholderColor={theme.faint}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                />
              </box>
            </box>
          }
        >
          {(current) => (
            <box flexDirection="column" marginTop={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
                {paged() ? `${state.page + 1}. ${current().question}` : current().question}
              </text>
              <box flexDirection="column" marginTop={1}>
                <Index each={current().options}>
                  {(option, index) => {
                    const focused = () => focus() === index
                    const on = () => state.chosen[state.page]?.includes(index) ?? false
                    const markColor = () => (focused() ? yellow(theme.rgb) : on() ? theme.text : theme.muted)
                    const note = () => state.notes[state.page]?.[index] ?? ""
                    return (
                      <box id={`option-${index}`} flexDirection="column" marginBottom={1}>
                        <box flexDirection="row">
                          <text fg={markColor()} flexShrink={0}>
                            {`${mark(current(), on())} `}
                          </text>
                          <text
                            fg={focused() ? yellow(theme.rgb) : theme.text}
                            attributes={focused() ? TextAttributes.BOLD : TextAttributes.NONE}
                            wrapMode="word"
                          >
                            {option().label}
                          </text>
                        </box>
                        <Show when={option().description}>
                          <box paddingLeft={2}>
                            <text fg={theme.muted} wrapMode="word">
                              {option().description}
                            </text>
                          </box>
                        </Show>
                        <Show
                          when={noting() && focused()}
                          fallback={
                            <Show when={note()}>
                              <box paddingLeft={2}>
                                <text fg={theme.accent} wrapMode="word">
                                  {note()}
                                </text>
                              </box>
                            </Show>
                          }
                        >
                          <box id="note" flexDirection="row" paddingLeft={2}>
                            <input
                              focused
                              flexGrow={1}
                              value={draft()}
                              onInput={setDraft}
                              placeholder="a note for Claude"
                              placeholderColor={theme.muted}
                              textColor={theme.accent}
                              focusedTextColor={theme.accent}
                            />
                          </box>
                        </Show>
                      </box>
                    )
                  }}
                </Index>
              </box>
              <box id="own-row" flexDirection="row">
                <text fg={onOwnRow() ? yellow(theme.rgb) : theme.muted} flexShrink={0}>
                  {"❯ "}
                </text>
                <input
                  focused={onOwnRow()}
                  flexGrow={1}
                  value={state.own[state.page] ?? ""}
                  onInput={typeOwn}
                  placeholder="or type your own answer…"
                  placeholderColor={theme.faint}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                />
              </box>
            </box>
          )}
        </Show>
      </AskScroll>
      <box flexDirection="row" justifyContent="flex-end" flexShrink={0}>
        <text fg={theme.faint} flexShrink={1}>
          {noting()
            ? NOTE_HINTS
            : question()
              ? questionHints(paged(), onOwnRow(), props.width)
              : fitHints(SUBMIT_HINTS, SHORT_SUBMIT_HINTS, props.width)}
        </text>
      </box>
      <Rule width={props.width} color={theme.frame} />
    </box>
  )
}
