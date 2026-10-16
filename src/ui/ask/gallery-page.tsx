import { Index, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { AskPicture, askImage } from "./ask-picture.tsx"
import { LETTERS, type Question } from "./question.ts"

const GAP = 2
const MIN_CARD = 24

// 2–4 designs side by side, in one row while each card gets MIN_CARD cells, else two per row.
export function GalleryPage(props: {
  question: Question
  width: number
  focus: number
  chosen: number[]
  notes: string[]
  noting: boolean
  draft: string
  onDraft: (text: string) => void
  onPick: (index: number) => void
  onOpen: (index: number) => void
}) {
  const count = () => props.question.options.length
  const perRow = () => {
    const all = count()
    return (props.width - GAP * (all - 1)) / all >= MIN_CARD ? all : 2
  }
  const card = () => Math.floor((props.width - GAP * (perRow() - 1)) / perRow())
  const pictureRows = () => Math.min(14, Math.max(6, Math.round(card() * 0.3)))
  return (
    <box flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={1}>
      <Index each={props.question.options}>
        {(option, index) => {
          const focused = () => props.focus === index
          const on = () => props.chosen.includes(index)
          const note = () => props.notes[index] ?? ""
          return (
            <box
              id={`option-${index}`}
              flexDirection="column"
              width={card()}
              onMouseDown={(event) => {
                event.preventDefault()
                props.onPick(index)
              }}
            >
              <text wrapMode="none" fg={focused() ? theme.accent : on() ? theme.text : theme.muted}>
                <span>{`${props.question.multiSelect ? (on() ? "■ " : "□ ") : ""}${LETTERS[index] ?? ""}. `}</span>
                <span style={{ bold: focused(), fg: focused() ? theme.accent : theme.text }}>{option().label}</span>
                <span style={{ fg: theme.accent }}>{on() && !props.question.multiSelect ? " ✓" : ""}</span>
              </text>
              <box border borderStyle="rounded" borderColor={focused() ? theme.accent : theme.frame}>
                <AskPicture
                  image={askImage(option().image)}
                  width={card() - 2}
                  height={pictureRows()}
                  onOpen={() => props.onOpen(index)}
                />
              </box>
              <Show when={option().description}>
                <text fg={theme.muted} wrapMode="word">
                  {option().description}
                </text>
              </Show>
              <Show
                when={props.noting && focused()}
                fallback={
                  <Show when={note()}>
                    <text fg={theme.accent} wrapMode="word">
                      {note()}
                    </text>
                  </Show>
                }
              >
                <box id="note" flexDirection="row">
                  <input
                    focused
                    flexGrow={1}
                    value={props.draft}
                    onInput={props.onDraft}
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
  )
}
