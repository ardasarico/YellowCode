import { RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { Match, Switch } from "solid-js"
import { theme } from "../theme/theme.ts"
import { wrapLines } from "./format.ts"
import { Markdown } from "./markdown/markdown.tsx"
import { InputEdge } from "./ultracode.tsx"

// Past this many rows the answer scrolls.
const MAX_ROWS = 14
const INDENT = 2

// About the rows the answer takes, so a short one leaves the chat its room.
const rowsOf = (text: string, width: number) =>
  text.split("\n").reduce((sum, line) => sum + Math.max(1, wrapLines(line, width, MAX_ROWS).length), 0)

// The answer to a side question (/btw), in the prompt's place; it never goes into the conversation.
export function BtwBand(props: {
  question: string
  // Undefined while it is asked, null when none came.
  answer: string | null | undefined
  width: number
  onCopy: (text: string) => void
  onClose: () => void
}) {
  const answer = () => props.answer
  let scroll: ScrollBoxRenderable | undefined
  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    if (key.name === "escape" || key.name === "return") props.onClose()
    else if (key.name === "up") scroll?.scrollBy({ x: 0, y: -1 })
    else if (key.name === "down") scroll?.scrollBy({ x: 0, y: 1 })
    else if (key.name === "c" && !key.ctrl && !key.meta) {
      const text = answer()
      if (text) props.onCopy(text)
    }
  })
  const inner = () => Math.max(1, props.width - INDENT - 1)
  const rows = (text: string) => Math.min(MAX_ROWS, rowsOf(text, inner()))
  const hints = () => {
    const text = answer()
    const scrolls = text ? rowsOf(text, inner()) > MAX_ROWS : false
    return [scrolls && "↑/↓ to scroll", text && "c to copy", "Esc to close"].filter(Boolean).join(" · ")
  }
  return (
    <box flexDirection="column" flexShrink={0} width={props.width}>
      <InputEdge width={props.width} ultracode={false} frame={0} glyph="─" hint={hints()} color={theme.accent} />
      <text wrapMode="none">
        <span style={{ fg: theme.accent, attributes: TextAttributes.BOLD }}>/btw</span>
        <span style={{ fg: theme.muted }}>{` ${props.question.replace(/\s+/g, " ")}`}</span>
      </text>
      <box height={1} />
      <box paddingLeft={INDENT} flexShrink={0}>
        <Switch>
          <Match when={answer() === undefined}>
            <text fg={theme.muted}>Asking a copy of this session…</text>
          </Match>
          <Match when={answer() === null}>
            <text fg={theme.muted}>No answer came. The log has the reason.</text>
          </Match>
          <Match when={answer()}>
            {(text) => (
              <scrollbox
                ref={(element) => (scroll = element)}
                height={rows(text())}
                width={props.width - INDENT}
                verticalScrollbarOptions={{
                  trackOptions: { foregroundColor: theme.muted, backgroundColor: RGBA.fromValues(0, 0, 0, 0) },
                }}
              >
                <Markdown markdown={text()} streaming={false} width={inner()} />
              </scrollbox>
            )}
          </Match>
        </Switch>
      </box>
      <box height={1} />
    </box>
  )
}
