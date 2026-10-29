import { CliRenderEvents, type CliRenderer } from "@opentui/core"
import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { log } from "../log/log.ts"
import type { NotificationSetting } from "../session/settings-file.ts"
import type { Session } from "../session/types.ts"
import { asksQuestions, pendingAsk } from "./ask/ask-surface.tsx"

export type Attention =
  | { state: "idle" | "working"; id: null }
  | { state: "done"; id: string }
  | { state: "error"; id: string; error: string }
  | { state: "blocked"; id: string; kind: "permission" | "question"; tool: string }

export function attentionState(session: Session): Attention {
  const ask = pendingAsk(session)
  if (ask) {
    return { state: "blocked", id: ask.id, kind: asksQuestions(ask) ? "question" : "permission", tool: ask.displayName }
  }
  if (session.status === "running") return { state: "working", id: null }
  for (let index = session.items.length - 1; index >= 0; index--) {
    const item = session.byId[session.items[index] ?? ""]
    if (item?.kind === "system" && item.level === "error") return { state: "error", id: item.id, error: item.text }
    if (item?.kind !== "turn-end") continue
    if (item.error === null) return { state: "done", id: item.id }
    return { state: "error", id: item.id, error: item.error }
  }
  return { state: "idle", id: null }
}

function attentionMessage(attention: Attention): string | null {
  if (attention.state === "blocked")
    return attention.kind === "question" ? "Claude has a question" : `Permission needed: ${attention.tool}`
  if (attention.state === "done") return "Done"
  if (attention.state === "error") return `Error: ${attention.error.split("\n")[0]}`
  return null
}

export function notification(attention: Attention, level: NotificationSetting): string | null {
  if (level === "off") return null
  if (level === "waiting" && attention.state === "done") return null
  return attentionMessage(attention)
}

export function useAttention(
  renderer: CliRenderer,
  session: () => Session,
  level: () => NotificationSetting,
): Accessor<boolean> {
  const [focused, setFocused] = createSignal(true)
  // Set from a notification until the user comes back to the terminal or replies.
  const [flagged, setFlagged] = createSignal(false)
  const onFocus = () => {
    setFocused(true)
    setFlagged(false)
  }
  const onBlur = () => setFocused(false)
  renderer.on(CliRenderEvents.FOCUS, onFocus)
  renderer.on(CliRenderEvents.BLUR, onBlur)
  onCleanup(() => {
    renderer.off(CliRenderEvents.FOCUS, onFocus)
    renderer.off(CliRenderEvents.BLUR, onBlur)
  })

  const attention = createMemo(() => attentionState(session()), undefined, {
    equals: (a, b) => a.state === b.state && a.id === b.id,
  })
  createEffect(
    on(attention, (current) => {
      const capabilities = renderer.capabilities
      const message = attentionMessage(current) ?? undefined
      if (capabilities?.program_status) {
        renderer.setProgramStatus(
          current.state === "blocked"
            ? { app: "yellowcode", state: "blocked", kind: current.kind, message }
            : { app: "yellowcode", state: current.state, message },
        )
      }
      const away = capabilities?.focus_tracking === false || !focused()
      const text = notification(current, level())
      const notified = away && text !== null && renderer.triggerNotification(text, "YellowCode")
      if (notified) setFlagged(true)
      // Terminals without focus reports never send the focus that clears the flag; working again means the user replied.
      else if (current.state === "working") setFlagged(false)
      log.debug(`attention ${current.state}`, {
        away,
        notified,
        focusTracking: capabilities?.focus_tracking,
        programStatus: capabilities?.program_status,
      })
    }),
  )
  return flagged
}
