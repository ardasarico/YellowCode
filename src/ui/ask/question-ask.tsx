import { type KeyEvent, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, Index, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { answerQuestions, denyTool, QUESTION_TO_CHAT } from "../../protocol/outgoing.ts"
import { theme } from "../../theme/theme.ts"
import { covered } from "../images.ts"
import { AskPicture, askImage, PICTURE_MIN_WIDTH, shownPicture } from "./ask-picture.tsx"
import { AskScroll } from "./ask-scroll.tsx"
import { GalleryPage } from "./gallery-page.tsx"
import { LETTERS, type Question, type QuestionInput } from "./question.ts"
import { fitKeyHints, pageWindow } from "./fit.ts"
import { typingGuard } from "./typing.ts"
import type { AskViewProps } from "./ask-surface.tsx"

const HINTS: [string, string][] = [
  ["←→", "question"],
  ["↑↓", "option"],
  ["space", "pick"],
  ["enter", "select"],
  ["n", "note"],
  ["esc", "back to chat"],
]
const NOTE_HINTS = "enter save · esc drop"
const OWN_HINTS = "↑ back · enter select · esc back to chat"
const SUBMIT_HINTS = "←→ question · ↓ note · enter submit · esc back to chat"
const SHORT_SUBMIT_HINTS = "←→ · ↓ · enter · esc"
const EXTRA_HINTS = "↑ back · enter submit · esc back to chat"
const SHORT_TEXT_HINTS = "↑ · enter · esc"

// Only the keys that act here: ←→ needs pages, or moves between designs in a gallery that is the only page;
// space marks only in a multi-select; z needs a picture.
function questionHints(paged: boolean, width: number, multi: boolean, pictures: boolean, gallery: boolean): string {
  const keys = HINTS.filter(([key]) => (paged || gallery || key !== "←→") && (multi || key !== "space"))
    .map(([key, action]): [string, string] => (key === "←→" && !paged ? [key, "design"] : [key, action]))
    .flatMap((hint): [string, string][] => (pictures && hint[0] === "n" ? [["z", "enlarge"], hint] : [hint]))
  const full = keys.map((hint) => hint.join(" ")).join(" · ")
  const short = keys.map(([key]) => key).join(" · ")
  return fitKeyHints(full, short, width)
}

// A key the input would type as text.
function printable(key: KeyEvent): boolean {
  if (key.name === "space") return true
  const code = key.sequence.charCodeAt(0)
  return code >= 32 && code !== 127
}

// `page` runs past the last question to Submit. Per page, `focus` is the cursor row: on a question the options'
// length is the own-answer row, on Submit 0 is the review and 1 the note row. Per question, `chosen` holds the
// marked options (at most one for a radio), `own` the typed answer, and `notes` one note per option. `extra` is
// the additional note on the Submit page.
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
  input: QuestionInput,
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

const hasPictures = (question: Question) => !question.gallery && question.options.some((option) => option.image)

// As tall as the option list beside it, so the ask does not grow for the picture.
function pictureRows(question: Question): number {
  const rows = question.options.reduce((sum, option) => sum + 2 + (option.description ? 1 : 0), -1)
  return Math.max(8, rows)
}

// A radio shows the cursor before the letter and a ✓ after the label; a multi-select keeps its box.
function marker(question: Question, index: number, on: boolean, focused: boolean): string {
  const lead = question.multiSelect ? (on ? "■" : "□") : focused ? "❯" : " "
  return `${lead} ${LETTERS[index] ?? ""}. `
}

function Rule(props: { width: number; color: typeof theme.frame }) {
  return (
    <text fg={props.color} wrapMode="none" flexShrink={0}>
      {"─".repeat(props.width)}
    </text>
  )
}

function PageBar(props: { questions: Question[]; page: number; answered: boolean[]; width: number }) {
  const bar = () =>
    pageWindow(
      props.questions.map((question) => question.header),
      props.page,
      props.answered,
      props.width,
    )
  return (
    <box flexDirection="row" flexShrink={0}>
      <text wrapMode="none" flexGrow={1}>
        <span>{"  "}</span>
        <Index each={bar().tabs}>
          {(tab, index) => {
            const current = () => tab().page === props.page
            return (
              <>
                {index > 0 ? " " : ""}
                <span
                  style={{
                    fg: current() ? theme.text : theme.muted,
                    bg: current() ? (theme.tile ?? theme.band ?? undefined) : undefined,
                    bold: current(),
                  }}
                >
                  {` ${tab().text} `}
                </span>
              </>
            )
          }}
        </Index>
      </text>
      <Show when={bar().indicator}>
        <text wrapMode="none" flexShrink={0} fg={theme.muted}>
          {bar().indicator}
        </text>
      </Show>
    </box>
  )
}

export function QuestionAsk(props: AskViewProps & { input: QuestionInput }) {
  const questions = () => props.input.questions
  const paged = () => questions().length > 1
  const [state, setState] = createStore<QuestionState>(
    untrack(() => ({
      page: 0,
      focus: [...questions().map(() => 0), 0],
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
  const onExtraRow = () => !question() && focus() === 1
  const scrollTarget = () => {
    if (noting()) return "note"
    if (!question()) return "extra-row"
    return onOwnRow() ? "own-row" : `option-${focus()}`
  }
  const fromTop = () => !noting() && (!question() || focus() === 0)
  const narrow = () => props.width < PICTURE_MIN_WIDTH
  const pictures = () => {
    const current = question()
    return current !== undefined && hasPictures(current) && !narrow()
  }
  const gallery = () => (question()?.gallery ?? false) && !narrow()
  const canEnlarge = () => (pictures() || gallery()) && shownPicture(question()?.options[focus()]?.image) !== null
  const optionsWidth = () => Math.floor((props.width * 2) / 5)
  const pictureIndex = () => Math.min(focus(), (question()?.options.length ?? 1) - 1)
  const openPictures = (index: number) => {
    const options = question()?.options ?? []
    const shown = options.flatMap((option, at) => {
      const image = shownPicture(option.image)
      return image ? [{ image, at }] : []
    })
    const start = shown.findIndex((entry) => entry.at === index)
    if (start >= 0)
      props.onOpenImages?.(
        shown.map((entry) => entry.image),
        start,
      )
  }

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

  // On a text row the focused input takes the keys this handler leaves alone, ←→ included, so they edit the text
  // there. Typing on the Submit review moves to its note row and the key lands in that input.
  const typing = typingGuard()
  useKeyboard((key) => {
    if (typing(key)) return key.preventDefault()
    if (props.answered || covered()) return
    // ↑↓ keep the note and go on moving, so a note never traps the cursor.
    if (noting()) {
      const moving = key.name === "up" || key.name === "down"
      if (key.name === "escape") setNoting(false)
      else if (key.name === "return" || moving) saveNote()
      else return
      if (!moving) {
        key.preventDefault()
        return
      }
    }
    const current = question()
    const last = current ? current.options.length : 1
    const onText = onOwnRow() || onExtraRow()
    if (key.name === "escape") props.onAnswer(denyTool(props.ask.requestId, QUESTION_TO_CHAT))
    else if (gallery() && !paged() && !onText && (key.name === "left" || key.name === "right")) {
      const step = key.name === "left" ? -1 : 1
      setState("focus", state.page, (card) => Math.min(last - 1, Math.max(0, card + step)))
    } else if (paged() && !onText && (key.name === "left" || key.name === "right")) {
      const step = key.name === "left" ? -1 : 1
      setState("page", (page) => Math.min(questions().length, Math.max(0, page + step)))
    } else if (key.name === "up") setState("focus", state.page, (row) => Math.max(0, row - 1))
    else if (key.name === "down") setState("focus", state.page, (row) => Math.min(last, row + 1))
    else if (key.name === "return") select()
    else if (onText || key.ctrl || key.meta) return
    else if (!current) {
      if (printable(key)) setState("focus", state.page, 1)
      return
    } else if (key.name === "space") choose(focus())
    else if (key.name === "n") openNote()
    else if (key.name === "z" && canEnlarge()) openPictures(focus())
    else if (/^[a-d]$/.test(key.name)) pick(LETTERS.indexOf(key.name.toUpperCase()))
    else return
    key.preventDefault()
  })

  // The root takes no width: a box with an explicit width does not shrink in height under its parent's maxHeight.
  return (
    <box flexDirection="column" flexShrink={1}>
      <Rule width={props.width} color={theme.frame} />
      <Show when={paged()}>
        <PageBar
          questions={questions()}
          page={state.page}
          answered={questions().map((current, index) => answerFor(current, state, index) !== "")}
          width={props.width}
        />
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
                <text fg={theme.accent} flexShrink={0}>
                  {onExtraRow() ? "❯ " : "  "}
                </text>
                <input
                  focused={onExtraRow()}
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
              <Show when={(hasPictures(current()) || current().gallery) && narrow()}>
                <text fg={theme.faint} marginTop={1}>
                  widen the window to see the previews
                </text>
              </Show>
              <Show
                when={!gallery()}
                fallback={
                  <box marginTop={1} marginBottom={1}>
                    <GalleryPage
                      question={current()}
                      width={props.width}
                      focus={focus()}
                      chosen={state.chosen[state.page] ?? []}
                      notes={state.notes[state.page] ?? []}
                      noting={noting()}
                      draft={draft()}
                      onDraft={setDraft}
                      onPick={(index) => setState("focus", state.page, index)}
                      onOpen={openPictures}
                    />
                  </box>
                }
              >
                <box flexDirection="row" marginTop={1} columnGap={2}>
                  <box flexDirection="column" width={pictures() ? optionsWidth() : undefined} flexGrow={1}>
                    <Index each={current().options}>
                      {(option, index) => {
                        const focused = () => focus() === index
                        const on = () => state.chosen[state.page]?.includes(index) ?? false
                        const markColor = () => (focused() ? theme.accent : on() ? theme.text : theme.muted)
                        const note = () => state.notes[state.page]?.[index] ?? ""
                        return (
                          <box id={`option-${index}`} flexDirection="column" marginBottom={1}>
                            <box flexDirection="row">
                              <text fg={markColor()} flexShrink={0}>
                                {marker(current(), index, on(), focused())}
                              </text>
                              <text
                                fg={focused() ? theme.accent : theme.text}
                                attributes={focused() ? TextAttributes.BOLD : TextAttributes.NONE}
                                wrapMode="word"
                              >
                                {option().label}
                                <span style={{ fg: theme.accent }}>{on() && !current().multiSelect ? " ✓" : ""}</span>
                              </text>
                            </box>
                            <Show when={option().description}>
                              <box paddingLeft={5}>
                                <text fg={theme.muted} wrapMode="word">
                                  {option().description}
                                </text>
                              </box>
                            </Show>
                            <Show
                              when={noting() && focused()}
                              fallback={
                                <Show when={note()}>
                                  <box paddingLeft={5}>
                                    <text fg={theme.accent} wrapMode="word">
                                      {note()}
                                    </text>
                                  </box>
                                </Show>
                              }
                            >
                              <box id="note" flexDirection="row" paddingLeft={5}>
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
                  <Show when={pictures()}>
                    <AskPicture
                      image={askImage(current().options[pictureIndex()]?.image)}
                      width={props.width - optionsWidth() - 2}
                      height={pictureRows(current())}
                      onOpen={() => openPictures(pictureIndex())}
                    />
                  </Show>
                </box>
              </Show>
              <box id="own-row" flexDirection="row">
                <text fg={theme.accent} flexShrink={0}>
                  {onOwnRow() ? "❯ " : "  "}
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
            : onOwnRow()
              ? fitKeyHints(OWN_HINTS, SHORT_TEXT_HINTS, props.width)
              : onExtraRow()
                ? fitKeyHints(EXTRA_HINTS, SHORT_TEXT_HINTS, props.width)
                : question()
                  ? questionHints(paged(), props.width, question()?.multiSelect ?? false, canEnlarge(), gallery())
                  : fitKeyHints(SUBMIT_HINTS, SHORT_SUBMIT_HINTS, props.width)}
        </text>
      </box>
      <Rule width={props.width} color={theme.frame} />
    </box>
  )
}
