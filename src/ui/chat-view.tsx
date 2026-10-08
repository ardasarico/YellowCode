import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, Show } from "solid-js"
import type { Session } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { ItemView } from "./item-view.tsx"

export function ChatView(props: {
  session: Session
  selected: string | null
  expanded: Record<string, boolean>
  onToggle: (id: string) => void
}) {
  let scroll: ScrollBoxRenderable | undefined

  createEffect(() => {
    const id = props.selected
    if (id) scroll?.scrollChildIntoView(id)
  })

  return (
    <scrollbox
      ref={(element) => (scroll = element)}
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingX={1}
      verticalScrollbarOptions={{
        trackOptions: { foregroundColor: theme.muted, backgroundColor: RGBA.fromValues(0, 0, 0, 0) },
      }}
    >
      <For each={props.session.items}>
        {(id) => (
          <Show when={props.session.byId[id]}>
            {(item) => (
              <ItemView
                item={item()}
                selected={props.selected === id}
                expanded={props.expanded[id] === true}
                onToggle={props.onToggle}
              />
            )}
          </Show>
        )}
      </For>
    </scrollbox>
  )
}
