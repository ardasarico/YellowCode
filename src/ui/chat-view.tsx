import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js"
import type { Session } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { ItemView } from "./item-view.tsx"
import { buildRows, type Row } from "./structure.ts"
import { UserMessageRow } from "./user-message.tsx"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

type ChatProps = {
  session: Session
  selected: string | null
  expanded: Record<string, boolean>
  onToggle: (id: string) => void
  onOverflow: (id: string, overflowing: boolean) => void
}

function itemsOf(row: Row): string[] {
  if (row.kind === "group") return row.items
  if (row.kind === "end") return row.turnEnds.slice(-1)
  return [row.id]
}

function RowView(props: ChatProps & { row: Row }) {
  const user = () => {
    const item = props.session.byId[props.row.id]
    return item?.kind === "user" ? item : undefined
  }
  return (
    <Switch>
      <Match when={user()}>
        {(item) => (
          <UserMessageRow
            item={item()}
            selected={props.selected === item().id}
            expanded={props.expanded[item().id] === true}
            onOverflow={props.onOverflow}
          />
        )}
      </Match>
      <Match when={props.row}>
        <For each={itemsOf(props.row)}>
          {(id) => (
            <Show when={props.session.byId[id]}>
              {(item) => (
                <box backgroundColor={(props.selected === id ? theme.selection : null) ?? CLEAR}>
                  <ItemView
                    item={item()}
                    selected={false}
                    expanded={props.expanded[id] === true}
                    onToggle={props.onToggle}
                  />
                </box>
              )}
            </Show>
          )}
        </For>
      </Match>
    </Switch>
  )
}

export function ChatView(props: ChatProps) {
  let scroll: ScrollBoxRenderable | undefined
  const rows = createMemo(() => buildRows(props.session))
  const rowIds = createMemo(() => rows().map((row) => row.id))
  const rowById = createMemo(() => new Map(rows().map((row) => [row.id, row])))

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
      <For each={rowIds()}>
        {(id) => <Show when={rowById().get(id)}>{(row) => <RowView {...props} row={row()} />}</Show>}
      </For>
    </scrollbox>
  )
}
