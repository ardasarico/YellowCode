import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, Match, onMount, Switch } from "solid-js"
import { theme } from "../theme/theme.ts"
import { PAD_X } from "./dialog/list-view.tsx"
import { CHROME_ROWS, Panel } from "./dialog/panel.tsx"
import { wrapLines } from "./format.ts"
import { Markdown } from "./markdown/markdown.tsx"

const WIDTH = 88
const HEIGHT = 30

// About the rows the answer takes, so a short one gets a short panel; a longer one scrolls.
const rowsOf = (text: string, width: number) =>
  text.split("\n").reduce((sum, line) => sum + Math.max(1, wrapLines(line, width, HEIGHT).length), 0)

// The answer to a side question (/btw), which never goes into the conversation.
export function BtwDialog(props: {
  question: string
  ask: () => Promise<string | null>
  onCopy: (text: string) => void
  onClose: () => void
}) {
  const dimensions = useTerminalDimensions()
  const [answer, setAnswer] = createSignal<string | null | undefined>(undefined)
  let scroll: ScrollBoxRenderable | undefined
  let open = true
  onMount(() => {
    void props.ask().then((text) => open && setAnswer(text))
    return () => (open = false)
  })
  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    const page = Math.max(1, (scroll?.viewport.height ?? 1) - 1)
    if (key.name === "escape" || key.name === "return") {
      open = false
      props.onClose()
    } else if (key.name === "up") scroll?.scrollBy({ x: 0, y: -1 })
    else if (key.name === "down") scroll?.scrollBy({ x: 0, y: 1 })
    else if (key.name === "pageup") scroll?.scrollBy({ x: 0, y: -page })
    else if (key.name === "pagedown") scroll?.scrollBy({ x: 0, y: page })
    else if (key.name === "c" && !key.ctrl && !key.meta) {
      const text = answer()
      if (text) props.onCopy(text)
    }
  })
  const footer = () => [...(answer() ? [{ action: "Copy", key: "c" }] : []), { action: "Close", key: "esc" }]
  return (
    <Panel
      width={WIDTH}
      height={Math.min(
        HEIGHT,
        dimensions().height - 2,
        CHROME_ROWS + rowsOf(answer() || " ", Math.min(WIDTH, dimensions().width) - PAD_X * 2 - 3),
      )}
      title={`btw · ${props.question.replace(/\s+/g, " ")}`}
      footer={footer()}
    >
      {(inner) => (
        <Switch>
          <Match when={answer() === undefined}>
            <text fg={theme.panelMuted}>Asking a copy of this session…</text>
          </Match>
          <Match when={answer() === null}>
            <text fg={theme.panelMuted}>No answer came. The log has the reason.</text>
          </Match>
          <Match when={answer()}>
            {(text) => (
              <scrollbox
                ref={(element) => (scroll = element)}
                flexGrow={1}
                paddingRight={1}
                verticalScrollbarOptions={{
                  trackOptions: { foregroundColor: theme.muted, backgroundColor: RGBA.fromValues(0, 0, 0, 0) },
                }}
              >
                <Markdown markdown={text()} streaming={false} width={Math.max(1, inner() - 2)} />
              </scrollbox>
            )}
          </Match>
        </Switch>
      )}
    </Panel>
  )
}
