import { type Accessor, createEffect, createMemo, createSignal, on, untrack } from "solid-js"
import { type SessionTitle, titleSession } from "../session/titler.ts"
import type { Session } from "../session/types.ts"

// Refreshes the title after every user message; one request at a time, then once more if messages arrived meanwhile.
// A message isCommand rules out (/model sonnet, /clear) names no work, so it neither asks nor counts.
export function useSessionTitle(
  session: () => Session,
  enabled: () => boolean,
  initial?: SessionTitle,
  isCommand: (text: string) => boolean = () => false,
): Accessor<SessionTitle | null> {
  const [title, setTitle] = createSignal<SessionTitle | null>(initial ?? null)
  const messages = createMemo(
    () =>
      session().items.flatMap((id) => {
        const item = session().byId[id]
        return item?.kind === "user" && !untrack(() => isCommand(item.text)) ? [item.text] : []
      }),
    [],
    { equals: (a, b) => a.length === b.length && a.every((text, index) => text === b[index]) },
  )
  const conversation = () => session().conversation
  let running = false
  let again = false

  async function refresh(): Promise<void> {
    if (running) {
      again = true
      return
    }
    running = true
    again = false
    const asked = untrack(conversation)
    // A request that throws must not leave `running` set, or no later message would ever refresh the title.
    const next = await titleSession(messages()).catch(() => null)
    // A title for the conversation before a /clear would name the new one.
    if (next && asked === untrack(conversation)) setTitle(next)
    running = false
    if (again) void refresh()
  }

  createEffect(on(conversation, () => setTitle(null), { defer: true }))
  // A message sent from here on, not the history a resumed session starts with or an earlier part loaded in front.
  const last = createMemo(() =>
    session().items.findLast((id) => {
      const item = session().byId[id]
      return item?.kind === "user" && !untrack(() => isCommand(item.text))
    }),
  )
  createEffect(
    on(
      last,
      () => {
        if (enabled() && messages().length > 0) void refresh()
      },
      { defer: true },
    ),
  )
  return title
}
