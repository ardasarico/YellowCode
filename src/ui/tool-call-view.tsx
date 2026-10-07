import { Show } from "solid-js"
import type { ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"

const ICON = { running: "⠋", done: "✓", error: "✗" } as const

function prettyInput(item: ToolCall): string {
  return item.input === undefined ? item.inputText : JSON.stringify(item.input, null, 2)
}

export function ToolCallView(props: {
  item: ToolCall
  selected: boolean
  expanded: boolean
  onToggle: (id: string) => void
}) {
  const color = () =>
    props.item.status === "error" ? theme.error : props.item.status === "done" ? theme.success : theme.muted

  return (
    <box id={props.item.id} flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => props.onToggle(props.item.id)}>
        <text fg={props.selected ? theme.accent : theme.muted}>{props.selected ? "›" : " "}</text>
        <text fg={color()}>{ICON[props.item.status]}</text>
        <text fg={theme.text}>
          <b>{props.item.name}</b>
        </text>
        <text fg={theme.muted}>{props.item.summary}</text>
      </box>
      <Show when={props.expanded}>
        <box flexDirection="column" paddingLeft={4}>
          <text fg={theme.muted}>{prettyInput(props.item)}</text>
          <Show when={props.item.result}>
            <text fg={props.item.status === "error" ? theme.error : theme.text}>{props.item.result}</text>
          </Show>
          <Show when={props.item.children.length > 0}>
            <text fg={theme.muted}>{`${props.item.children.length} subagent messages`}</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}
