import { type Accessor, createEffect, createMemo, createSignal, on } from "solid-js"
import { type SessionTitle, titleSession } from "../session/titler.ts"
import type { Session } from "../session/types.ts"

// Refreshes the title after every user message; one request at a time, then once more if messages arrived meanwhile.
export function useSessionTitle(session: () => Session, enabled: () => boolean): Accessor<SessionTitle | null> {
  const [title, setTitle] = createSignal<SessionTitle | null>(null)
  const messages = createMemo(
    () =>
      session().items.flatMap((id) => {
        const item = session().byId[id]
        return item?.kind === "user" ? [item.text] : []
      }),
    [],
    { equals: (a, b) => a.length === b.length },
  )
  let running = false
  let again = false

  async function refresh(): Promise<void> {
    if (running) {
      again = true
      return
    }
    running = true
    again = false
    const next = await titleSession(messages())
    if (next) setTitle(next)
    running = false
    if (again) void refresh()
  }

  createEffect(
    on(messages, (texts) => {
      if (enabled() && texts.length > 0) void refresh()
    }),
  )
  return title
}
