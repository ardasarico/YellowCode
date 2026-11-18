import { createEffect, createSignal, on, Show } from "solid-js"
import type { Session } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { ClaudeMark } from "./figures.tsx"
import { cut, formatDuration } from "./format.ts"
import { useTicker } from "./ticker.ts"

// What the agent is doing while its turn runs, from the latest item; "" when a running tool row already says it, null
// when nothing should show: no turn, an ask open, or a compaction the prompt bar counts.
export function workingText(session: Session): string | null {
  if (session.turn === null || session.status !== "running" || session.compacting) return null
  for (const id of session.items.toReversed()) {
    const item = session.byId[id]
    if (!item || (item.kind === "user" && item.queue !== null)) continue
    if (item.kind === "ask") {
      if (item.status === "pending") return null
      continue
    }
    if (item.kind === "tool") {
      if (item.status === "running") return ""
      if (item.toolKind === "agent" && item.agent) return `reading the result of ${item.agent.name || item.title}`
      return "thinking"
    }
    if (item.kind === "text") return item.streaming ? "" : "working"
    // The thinking row shows its own paw and time while it streams.
    if (item.kind === "thinking" && item.streaming) return null
    return "thinking"
  }
  return "thinking"
}

// A live row under the chat for as long as the agent's turn runs, so a turn with nothing new to show still looks busy.
export function WorkingRow(props: { session: Session; width: number }) {
  const [startedAt, setStartedAt] = createSignal(Date.now())
  createEffect(
    on(
      () => props.session.turn !== null,
      (running) => {
        if (running) setStartedAt(Date.now())
      },
    ),
  )
  const text = () => workingText(props.session)
  const tick = useTicker(() => text() !== null, 1000)
  const line = () => {
    tick()
    const elapsed = formatDuration(Date.now() - startedAt())
    return cut(text() ? `${text()} · ${elapsed}` : elapsed, Math.max(1, props.width - 2))
  }
  return (
    <Show when={text() !== null}>
      <box flexDirection="row" marginTop={1} flexShrink={0}>
        <ClaudeMark running />
        <text fg={theme.muted} wrapMode="none">
          {` ${line()}`}
        </text>
      </box>
    </Show>
  )
}
