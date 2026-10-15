import { Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { cut } from "../format.ts"
import { fill, PAD_X } from "./list-view.tsx"

// The two rows of `⌕` with the query over an underline; the search mark and the line take the accent while it
// has the focus. A long query shows its end.
export function SearchField(props: { query: string; placeholder: string; focused: boolean; width: number }) {
  const color = () => (props.focused ? theme.accent : theme.frame)
  const room = () => Math.max(0, props.width - 3)
  const query = () => (Bun.stringWidth(props.query) > room() ? props.query.slice(-room()) : props.query)
  const placeholder = () => cut(props.placeholder, props.width - 2)

  return (
    <box flexDirection="column" paddingLeft={PAD_X}>
      <box height={1}>
        <text wrapMode="none">
          <span style={{ fg: color() }}>{"⌕ "}</span>
          <Show
            when={props.query}
            fallback={
              <Show when={props.focused} fallback={<span style={{ fg: theme.panelFaint }}>{placeholder()}</span>}>
                <span style={{ fg: fill(), bg: theme.text }}>{placeholder().slice(0, 1)}</span>
                <span style={{ fg: theme.panelFaint }}>{placeholder().slice(1)}</span>
              </Show>
            }
          >
            <span style={{ fg: theme.text }}>{query()}</span>
            <Show when={props.focused}>
              <span style={{ bg: theme.text }}> </span>
            </Show>
          </Show>
        </text>
      </box>
      <box height={1}>
        <text fg={color()} wrapMode="none">
          {"─".repeat(Math.max(0, props.width))}
        </text>
      </box>
    </box>
  )
}
