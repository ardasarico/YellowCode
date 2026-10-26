import { createComponent, createSignal, ErrorBoundary, untrack } from "solid-js"
import type { ModPanePosition, ModPaneViewProps } from "../mods/api.ts"
import {
  focusedPane,
  modPanes,
  type RegisteredPane,
  reportModError,
  setFocusedPane,
  setPaneKeys,
} from "../mods/registry.ts"
import { theme } from "../theme/theme.ts"

export const shownPane = (position: ModPanePosition) =>
  modPanes().find((pane) => pane.visible() && pane.position() === position)

// Panes that are shown but get no room in this window; /mods says so.
const [crowded, setCrowded] = createSignal<ReadonlySet<string>>(new Set())
export { crowded, setCrowded }

// A mod's pane with its edge: a rule above a bottom pane, a bar left of a right one. Pressing the edge starts a resize.
export function ModPaneView(props: {
  pane: RegisteredPane
  // The whole pane, its edge included.
  width: number
  height: number
  onResizeStart: () => void
}) {
  const mod = untrack(() => props.pane.mod)
  const bottom = () => props.pane.position() === "bottom"
  const focused = () => focusedPane() === props.pane.key
  const edge = () => (focused() ? theme.accent : theme.frame)
  const viewProps: ModPaneViewProps = {
    get width() {
      return bottom() ? props.width : props.width - 1
    },
    get height() {
      return bottom() ? props.height - 1 : props.height
    },
    get focused() {
      return focused()
    },
    onKey: (handler) => setPaneKeys(props.pane.key, handler),
  }
  const content = () => (
    <box
      width={viewProps.width}
      height={viewProps.height}
      overflow="hidden"
      onMouseDown={(event) => {
        event.stopPropagation()
        setFocusedPane(props.pane.key)
      }}
    >
      <ErrorBoundary
        fallback={(error: unknown) => {
          queueMicrotask(() => reportModError(mod, error))
          return null
        }}
      >
        {createComponent(props.pane.view, viewProps)}
      </ErrorBoundary>
    </box>
  )
  return (
    <box flexDirection={bottom() ? "column" : "row"} width={props.width} height={props.height} flexShrink={0}>
      <box
        width={bottom() ? props.width : 1}
        height={bottom() ? 1 : props.height}
        onMouseDown={(event) => {
          event.stopPropagation()
          props.onResizeStart()
        }}
      >
        <text fg={edge()} wrapMode="none">
          {bottom() ? "─".repeat(props.width) : "│\n".repeat(props.height).trimEnd()}
        </text>
      </box>
      {content()}
    </box>
  )
}
