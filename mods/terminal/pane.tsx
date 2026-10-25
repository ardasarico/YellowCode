import type { BoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, For, on, onCleanup, untrack } from "solid-js"
import { type PaneViewProps, theme } from "yellowcode/mod"
import type { Terminals } from "./terminals.ts"

// A strip of tabs over the active terminal. Every terminal stays mounted at full size, stacked, with the active one on
// top: a hidden renderable is laid out at zero size, which would wipe its screen.
export function TerminalPane(props: PaneViewProps & { terminals: Terminals }) {
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
