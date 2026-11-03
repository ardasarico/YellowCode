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

// The last model the mods were told of. It outlives the App, which a provider switch starts again, and the model is
// unknown for a moment while another agent starts, so the change is from this one to the next known one.
let known: string | null = null

// Tells the mods what happens in the session. Only what happens during a turn counts, so loading a transcript fires
// nothing.
export function useModEvents(renderer: CliRenderer, session: () => Session, model: () => string | null): void {
  const running = new Set<string>()
  // Only new items and running tools are read, so a long session costs no more than a short one.
  let seen = 0
  let last: Session | null = null
  createEffect(() => {
    const current = session()
    if (current !== last || current.items.length < seen) {
      last = current
      seen = 0
      running.clear()
    }
    for (const id of current.items.slice(seen)) {
      const item = current.byId[id]
      if (item?.kind === "tool" && item.status === "running") running.add(id)
    }
    seen = current.items.length
    for (const id of running) {
      const item = current.byId[id]
      if (item?.kind === "tool" && item.status === "running") continue
      running.delete(id)
      if (item?.kind === "tool" && item.status !== "running")
        emitModEvent("tool-done", { name: item.name, kind: item.toolKind, status: item.status })
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
  createEffect(
    on(model, (now) => {
      if (now === null) return
      // The model becoming known at start is not a change.
      if (known !== null && now !== known) emitModEvent("model-changed", { model: now })
      known = now
    }),
  )
  renderer.on(CliRenderEvents.FOCUS, onFocus)
  onCleanup(() => renderer.off(CliRenderEvents.FOCUS, onFocus))
}
