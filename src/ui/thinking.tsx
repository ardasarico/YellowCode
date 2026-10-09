import { Show } from "solid-js"
import type { Thinking } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { useElapsedSeconds } from "./elapsed.ts"
import { ClaudeMark } from "./figures.tsx"

function ThinkingLine() {
  const seconds = useElapsedSeconds(() => true)
  return (
    <box flexDirection="row">
      <ClaudeMark running />
      <text fg={theme.muted}>{` thinking… ${seconds()}s`}</text>
    </box>
  )
}

// Thinking leaves no trace once it ends; only a live line shows while it runs.
export function ThinkingRow(props: { item: Thinking }) {
  return (
    <Show when={props.item.streaming}>
      <ThinkingLine />
    </Show>
  )
}
