import { CliRenderEvents, type CliRenderer } from "@opentui/core"
import { createEffect, on, onCleanup } from "solid-js"
import { emitModEvent } from "../mods/registry.ts"
import type { Session } from "../session/types.ts"

function lastTurnError(session: Session): string | null {
  for (let index = session.items.length - 1; index >= 0; index--) {
    const item = session.byId[session.items[index] ?? ""]
    if (item?.kind === "turn-end") return item.error
  }
  return null
}

const onFocus = () => emitModEvent("focus", {})

// Tells the mods what happens in the session. Only what happens during a turn counts, so loading a transcript fires
// nothing.
export function useModEvents(renderer: CliRenderer, session: () => Session): void {
  const running = new Set<string>()
  createEffect(() => {
    const current = session()
    for (const id of current.items) {
      const item = current.byId[id]
      if (item?.kind !== "tool") continue
      if (item.status === "running") running.add(id)
      else if (running.delete(id) && current.status === "running")
        emitModEvent("tool-done", { name: item.name, status: item.status })
    }
  })
  createEffect(
    on(
      () => session().status,
      (status, previous) => {
        if (previous === "running" && status !== "running")
          emitModEvent("turn-end", { error: lastTurnError(session()) })
      },
    ),
  )
  renderer.on(CliRenderEvents.FOCUS, onFocus)
  onCleanup(() => renderer.off(CliRenderEvents.FOCUS, onFocus))
}
