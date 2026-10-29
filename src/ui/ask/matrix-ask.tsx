import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, Index, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { Answers, Matrix } from "../../agent/ask.ts"
import { theme } from "../../theme/theme.ts"
import { cut } from "../format.ts"
import { covered } from "../images.ts"
import { AskScroll } from "./ask-scroll.tsx"
import type { AskViewProps } from "./ask-surface.tsx"
import { cutStep, fitKeyHints, LABEL_EXTRA, matrixColumns, stackSteps, STEP_EXTRA, wrapRows } from "./fit.ts"
import { typingGuard } from "./typing.ts"

const MATRIX_PAGE = 8
// When a step would be cut beside the labels, each row's steps go in full on the rows under its label, six rows
// to a page.
const STACKED_PAGE = 6
const STEPS_INDENT = 4
const HINTS = "↑↓ row · ←→ move · space pick · enter pick and next · n note · esc back to chat"
const SHORT_HINTS = "↑↓ · ←→ · space · enter · n · esc"
const NOTE_HINTS = "enter save · esc drop"
const NOTE_GAP = 2

// `answers` holds the chosen step per row, -1 while open. `cursor` is the step ←→ stand on; it stays in its column
// when ↑↓ change the row.
type MatrixState = { row: number; cursor: number; answers: number[]; notes: string[] }

function matrixAnswers(matrix: Matrix, state: Pick<MatrixState, "answers" | "notes">): Answers {
  const values: Record<string, string[]> = {}
  const notes: Record<string, string> = {}
  matrix.rows.forEach((row, index) => {
    const step = matrix.scale[state.answers[index] ?? -1]
    values[row] = step === undefined ? [] : [step]
    const note = state.notes[index]?.trim()
    if (note) notes[row] = note
  })
  return { values, fields: {}, notes, note: "" }
}

function Rule(props: { width: number }) {
  return (
    <text fg={theme.frame} wrapMode="none" flexShrink={0}>
      {"─".repeat(props.width)}
    </text>
  )
}

// The focused row's answer takes the accent; the step under the cursor gets a band.
function Step(props: { text: string; on: boolean; here: boolean; focused: boolean }) {
  const color = () => (props.here || (props.on && props.focused) ? theme.accent : props.on ? theme.text : theme.muted)
  return (
    <span
      style={{
        fg: color(),
        bg: props.here ? (theme.selection ?? undefined) : undefined,
        bold: props.on && props.focused,
      }}
    >
      {` ${props.on ? "●" : "○"} ${props.text} `}
    </span>
  )
}

// Rows answered on one shared scale, eight to a page or six stacked; ↓ past a page's last row opens the next one.
export function MatrixAsk(props: AskViewProps & { matrix: Matrix }) {
  const rows = () => props.matrix.rows
  const scale = () => props.matrix.scale
  const [state, setState] = createStore<MatrixState>(
    untrack(() => ({
      row: 0,
      cursor: 0,
      answers: rows().map(() => -1),
      notes: rows().map(() => ""),
    })),
  )
  const [noting, setNoting] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const columns = createMemo(() => matrixColumns(rows(), scale(), props.width))
  const labelWidth = () => columns().label + LABEL_EXTRA
  const stacked = () => columns().limits.some((limit) => limit < Infinity)
  const pageSize = () => (stacked() ? STACKED_PAGE : MATRIX_PAGE)
  const first = () => Math.floor(state.row / pageSize()) * pageSize()
  const shown = () => rows().slice(first(), first() + pageSize())
  const indicator = () =>
    rows().length > pageSize() ? `${first() + 1}–${first() + shown().length} of ${rows().length}` : ""
  const labelRows = createMemo(() => rows().map((row) => wrapRows(row, stacked() ? props.width - 2 : columns().label)))
  const stepRows = createMemo(() => stackSteps(scale(), props.width - STEPS_INDENT + 1))
  // Every page takes the height of the tallest, so the ask does not jump.
  const pageHeight = (from: number) => {
    const steps = stacked() ? stepRows().length : 0
    return labelRows()
      .slice(from, from + pageSize())
      .reduce((sum, lines) => sum + lines.length + steps, 0)
  }
  const tallestPage = createMemo(() => {
    let tallest = 0
    for (let from = 0; from < rows().length; from += pageSize()) tallest = Math.max(tallest, pageHeight(from))
    return tallest
  })
  const filler = () => (rows().length > pageSize() ? tallestPage() - pageHeight(first()) : 0)
  // The cursor's step shows in full; the others may be cut.
  const stepTexts = createMemo(() => {
    const { limits, cursorLimit } = columns()
    return scale().map((step, at) => cutStep(step, at === state.cursor ? cursorLimit : (limits[at] ?? cursorLimit)))
  })
  const stepsWidth = () => stepTexts().reduce((sum, text) => sum + Bun.stringWidth(text) + STEP_EXTRA, 0)
  const noteWidth = () => Math.max(0, props.width - labelWidth() - stepsWidth() - NOTE_GAP)

  const answer = (step: number) => {
    setState("answers", state.row, step)
    if (step >= 0) setState("cursor", step)
  }
  const cursor = () => state.cursor
  const toggle = (step: number) => answer(state.answers[state.row] === step ? -1 : step)
  const saveNote = () => {
    setState("notes", state.row, draft().trim())
    setNoting(false)
  }
  // Enter picks the cursor's step, then goes to the next open row, or sends once none is left.
  const pickAndNext = () => {
    answer(cursor())
    const count = rows().length
    for (let step = 1; step <= count; step++) {
      const row = (state.row + step) % count
      if ((state.answers[row] ?? -1) < 0) return setState("row", row)
    }
    props.onAnswer({ type: "answers", answers: matrixAnswers(props.matrix, state) })
  }
  const openNote = () => {
    setDraft(state.notes[state.row] ?? "")
    setNoting(true)
  }

  const noteInput = () => (
    <input
      focused
      flexGrow={1}
      value={draft()}
      onInput={setDraft}
      placeholder={`a note for ${props.agent}`}
      placeholderColor={theme.muted}
      textColor={theme.accent}
      focusedTextColor={theme.accent}
    />
  )

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
    const last = rows().length - 1
    if (key.name === "escape") props.onAnswer({ type: "declined", chat: true })
    else if (key.name === "up") setState("row", Math.max(0, state.row - 1))
    else if (key.name === "down") setState("row", Math.min(last, state.row + 1))
    else if (key.name === "left" || key.name === "right") {
      const step = key.name === "left" ? -1 : 1
      setState("cursor", Math.min(scale().length - 1, Math.max(0, cursor() + step)))
    } else if (key.name === "return") pickAndNext()
    else if (key.ctrl || key.meta) return
    else if (key.name === "space") toggle(cursor())
    else if (key.name === "n") openNote()
    else if (/^[1-9]$/.test(key.name) && Number(key.name) <= scale().length) {
      const step = Number(key.name) - 1
      const clearing = state.answers[state.row] === step
      toggle(step)
      if (!clearing) setState("row", Math.min(last, state.row + 1))
    } else return
    key.preventDefault()
  })

  return (
    <box flexDirection="column" flexShrink={1}>
      <Rule width={props.width} />
      <AskScroll focus={`row-${state.row - first()}`} fromTop={state.row === first()} scope={first()}>
        <box flexDirection="row" marginTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word" flexGrow={1} flexShrink={1}>
            {props.matrix.question}
          </text>
          <text fg={theme.muted} wrapMode="none" flexShrink={0}>
            {indicator() ? `  ${indicator()}` : ""}
          </text>
        </box>
        <box flexDirection="column" marginTop={1}>
          <Index each={shown()}>
            {(row, offset) => {
              const index = () => first() + offset
              const focused = () => index() === state.row
              const chosen = () => state.answers[index()] ?? -1
              const note = () => state.notes[index()] ?? ""
              const label = () =>
                (labelRows()[index()] ?? [])
                  .map((line, at) => `${focused() && at === 0 ? "❯" : " "} ${line}`)
                  .join("\n")
              const labelColor = () => (focused() ? theme.accent : theme.text)
              const labelAttributes = () => (focused() ? TextAttributes.BOLD : TextAttributes.NONE)
              return (
                <Show
                  when={stacked()}
                  fallback={
                    <box id={`row-${offset}`} flexDirection="row">
                      <text
                        width={labelWidth()}
                        flexShrink={0}
                        wrapMode="none"
                        fg={labelColor()}
                        attributes={labelAttributes()}
                      >
                        {label()}
                      </text>
                      <text wrapMode="none" flexShrink={0}>
                        <Index each={scale()}>
                          {(_, at) => (
                            <Step
                              text={stepTexts()[at] ?? ""}
                              on={chosen() === at}
                              here={focused() && state.cursor === at}
                              focused={focused()}
                            />
                          )}
                        </Index>
                      </text>
                      <Show
                        when={noting() && focused()}
                        fallback={
                          <text fg={theme.accent} wrapMode="none" flexShrink={1}>
                            {note() ? " ".repeat(NOTE_GAP) + cut(note(), noteWidth()) : ""}
                          </text>
                        }
                      >
                        <box flexDirection="row" flexGrow={1} marginLeft={NOTE_GAP}>
                          {noteInput()}
                        </box>
                      </Show>
                    </box>
                  }
                >
                  <box id={`row-${offset}`} flexDirection="column">
                    <text wrapMode="none" fg={labelColor()} attributes={labelAttributes()}>
                      {label()}
                    </text>
                    <box flexDirection="column" paddingLeft={STEPS_INDENT - 1}>
                      <Index each={stepRows()}>
                        {(line) => (
                          <text wrapMode="none">
                            <Index each={line()}>
                              {(entry) => (
                                <Step
                                  text={entry().text}
                                  on={chosen() === entry().at}
                                  here={focused() && state.cursor === entry().at}
                                  focused={focused()}
                                />
                              )}
                            </Index>
                          </text>
                        )}
                      </Index>
                    </box>
                    <Show
                      when={noting() && focused()}
                      fallback={
                        <Show when={note()}>
                          <box paddingLeft={STEPS_INDENT}>
                            <text fg={theme.accent} wrapMode="word">
                              {note()}
                            </text>
                          </box>
                        </Show>
                      }
                    >
                      <box flexDirection="row" paddingLeft={STEPS_INDENT}>
                        {noteInput()}
                      </box>
                    </Show>
                  </box>
                </Show>
              )
            }}
          </Index>
          <box height={filler()} />
        </box>
      </AskScroll>
      <box flexDirection="row" justifyContent="flex-end" flexShrink={0} marginTop={1}>
        <text fg={theme.faint} flexShrink={1}>
          {noting() ? NOTE_HINTS : fitKeyHints(HINTS, SHORT_HINTS, props.width)}
        </text>
      </box>
      <Rule width={props.width} />
    </box>
  )
}
