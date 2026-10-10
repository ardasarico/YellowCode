import { createSignal, Show } from "solid-js"
import type { SystemEvent } from "../session/types.ts"
import { theme } from "../theme/theme.ts"

export function Divider(props: { text: string }) {
  const [width, setWidth] = createSignal(0)
  const line = () => {
    const label = ` ${props.text} `
    const left = Math.max(0, Math.floor((width() - label.length) / 2))
    const right = Math.max(0, width() - label.length - left)
    return { left: "─".repeat(left), label, right: "─".repeat(right) }
  }
  return (
    <box
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <text wrapMode="none">
        <span style={{ fg: theme.frame }}>{line().left}</span>
        <span style={{ fg: theme.muted }}>{line().label}</span>
        <span style={{ fg: theme.frame }}>{line().right}</span>
      </text>
    </box>
  )
}

// An info event marks a turning point in the session, so it spans the width; a warning is a single line.
export function SystemRow(props: { item: SystemEvent }) {
  return (
    <Show when={props.item.level === "info"} fallback={<text fg={theme.warning}>{`! ${props.item.text}`}</text>}>
      <Divider text={props.item.text} />
    </Show>
  )
}
