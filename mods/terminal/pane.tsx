import type { BoxRenderable, RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, For, on, onCleanup, untrack } from "solid-js"
import { type ModPaneViewProps, theme } from "yellowcode/mod"
import type { Terminals } from "./terminals.ts"

const COMMAND_POLL_MS = 1000

const hex = (color: RGBA) =>
  `#${color
    .toInts()
    .slice(0, 3)
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`

// A strip of tabs over the active terminal. Every terminal stays mounted at full size, stacked, with the active one on
// top: a hidden renderable is laid out at zero size, which would wipe its screen.
export function TerminalPane(props: ModPaneViewProps & { terminals: Terminals }) {
  const rows = () => Math.max(1, props.height - 1)

  createEffect(on([() => props.width, rows], ([cols, height]) => props.terminals.resize(cols, height)))

  const terminals = untrack(() => props.terminals)
  const renderer = useRenderer()
  // A native terminal paints only when its screen changes, so coming back on top needs a fresh paint.
  createEffect(
    on(
      () => terminals.active(),
      (terminal) => terminal?.view?.invalidate(),
    ),
  )
  untrack(() => props.onKey)((key) => {
    const terminal = terminals.active()
    if (terminal?.view) terminal.pty.write(terminal.view.encodeKey(key))
  })
  // The terminal's own default colors follow the theme (OSC 10 and 11), so blank cells match the chat. A theme that
  // leaves the window's background gives none, and the terminal keeps its own.
  createEffect(() => {
    const background = theme.background
    const text = theme.text
    for (const terminal of props.terminals.list()) {
      const view = terminals.viewOf(terminal, renderer)
      view.write(`\x1b]10;${hex(text)}\x07`)
      if (background) view.write(`\x1b]11;${hex(background)}\x07`)
    }
  })
  // Which program runs in each tab, for its label; only while the pane is shown.
  const poll = setInterval(() => void terminals.refreshCommands(), COMMAND_POLL_MS)
  onCleanup(() => clearInterval(poll))
  const encoder = new TextEncoder()
  untrack(() => props.onPaste)((text) => {
    const terminal = terminals.active()
    if (terminal?.view) terminal.pty.write(terminal.view.encodePaste(encoder.encode(text)))
  })

  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <box height={1} flexDirection="row" gap={2} paddingLeft={1}>
        <For each={props.terminals.list()}>
          {(terminal, index) => (
            <text
              fg={props.terminals.active() === terminal ? theme.accent : theme.muted}
              onMouseDown={() => props.terminals.selectId(terminal.id)}
            >
              {`${index() + 1} ${terminal.title}`}
            </text>
          )}
        </For>
        <text fg={theme.muted} onMouseDown={() => props.terminals.add()}>
          +
        </text>
      </box>
      <box width={props.width} height={rows()}>
        <For each={props.terminals.list()}>
          {(terminal) => (
            <box
              position="absolute"
              top={0}
              left={0}
              width={props.width}
              height={rows()}
              zIndex={props.terminals.active() === terminal ? 1 : 0}
              ref={(slot: BoxRenderable) => {
                const view = terminals.viewOf(terminal, renderer)
                slot.add(view)
                // Taken out before the slot goes, so the view and its screen live on while the pane is hidden.
                onCleanup(() => slot.remove(view))
              }}
            />
          )}
        </For>
      </box>
    </box>
  )
}
