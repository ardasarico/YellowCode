import { RGBA } from "@opentui/core"
import { Show } from "solid-js"
import type { Thinking } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { useElapsedSeconds } from "./elapsed.ts"
import { ClaudeMark } from "./figures.tsx"
import { FoldHint } from "./fold-hint.tsx"
import { formatDuration } from "./format.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

function ThinkingLine() {
  const seconds = useElapsedSeconds(() => true)
  return (
    <box flexDirection="row">
      <ClaudeMark running />
      <text fg={theme.muted}>{` thinking… ${seconds()}s`}</text>
    </box>
  )
}

export const hasThinkingText = (item: Thinking) => !item.streaming && item.text.trim() !== ""

function ThinkingTrace(props: {
  item: Thinking
  selected: boolean
  expanded: boolean
  onToggle?: (id: string) => void
}) {
  const label = () =>
    props.item.durationMs === null ? "✻ thought" : `✻ thought for ${formatDuration(props.item.durationMs)}`
  return (
    <box flexDirection="column">
      <box
        id={props.item.id}
        alignSelf="flex-start"
        backgroundColor={(props.selected ? theme.selection : null) ?? CLEAR}
        onMouseDown={(event) => {
          if (!hasThinkingText(props.item)) return
          event.preventDefault()
          props.onToggle?.(props.item.id)
        }}
      >
        <text fg={theme.muted} wrapMode="none">
          {label()}
          <FoldHint open={props.expanded} selected={props.selected} verbs={["show", "hide"]} gap=" · " />
        </text>
      </box>
      <Show when={props.expanded && hasThinkingText(props.item)}>
        <box paddingLeft={2} marginTop={1}>
          <text fg={theme.muted} wrapMode="word">
            {props.item.text.trim()}
          </text>
        </box>
      </Show>
    </box>
  )
}

export function ThinkingRow(props: {
  item: Thinking
  selected?: boolean
  expanded?: boolean
  onToggle?: (id: string) => void
}) {
  return (
    <Show when={!props.item.streaming} fallback={<ThinkingLine />}>
      <ThinkingTrace
        item={props.item}
        selected={props.selected ?? false}
        expanded={props.expanded ?? false}
        onToggle={props.onToggle}
      />
    </Show>
  )
}
