import { createSignal, onCleanup, Show } from "solid-js"
import type { Thinking } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { useElapsedSeconds } from "./elapsed.ts"

const FRAMES = ["✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳"]

function ThinkingLine() {
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((index) => (index + 1) % FRAMES.length), 120)
  onCleanup(() => clearInterval(timer))
  const seconds = useElapsedSeconds(() => true)
  return (
    <text>
      <span style={{ fg: theme.claude }}>{FRAMES[frame()]}</span>
      <span style={{ fg: theme.muted }}>{` thinking… ${seconds()}s`}</span>
    </text>
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
