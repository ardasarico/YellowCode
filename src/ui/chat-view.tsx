import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js"
import type { Item, Session } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { ItemView } from "./item-view.tsx"
import { buildRows, type Row } from "./structure.ts"
import { ThinkingRow } from "./thinking.tsx"
import { ToolCallRow } from "./tool-call.tsx"
import { TurnEndRow } from "./turn-end.tsx"
import { UserMessageRow } from "./user-message.tsx"

type ChatProps = {
  session: Session
  selected: string | null
  expanded: Record<string, boolean>
  onToggle: (id: string) => void
  onOverflow: (id: string, overflowing: boolean) => void
}

function isKind<K extends Item["kind"]>(item: Item, kind: K): item is Extract<Item, { kind: K }> {
  return item.kind === kind
}

function RowView(props: ChatProps & { row: Row; previous: Row["kind"] | undefined }) {
  const item = <K extends Item["kind"]>(kind: K) => {
    const found = props.session.byId[props.row.id]
    return found && isKind(found, kind) ? found : undefined
  }
  const turnEnds = () =>
    props.row.kind === "end"
      ? props.row.turnEnds.flatMap((id) => {
          const found = props.session.byId[id]
          return found?.kind === "turn-end" ? [found] : []
        })
      : null
  const gap = () => {
    if (props.row.kind === "thinking" && !item("thinking")?.streaming) return 0
    return props.row.kind === "user" && props.previous === "end" ? 2 : 1
  }

  return (
    <box marginTop={gap()}>
      <Switch
        fallback={
          <Show when={props.session.byId[props.row.id]}>
            {(found) => (
              <ItemView
                item={found()}
                selected={props.selected === props.row.id}
                expanded={props.expanded[props.row.id] === true}
                onToggle={props.onToggle}
              />
            )}
          </Show>
        }
      >
        <Match when={item("user")}>
          {(user) => (
            <UserMessageRow
              item={user()}
              selected={props.selected === user().id}
              expanded={props.expanded[user().id] === true}
              onOverflow={props.onOverflow}
            />
          )}
        </Match>
        <Match when={props.row.kind === "tool" && item("tool")}>
          {(tool) => (
            <ToolCallRow
              item={tool()}
              cwd={props.session.info?.cwd ?? ""}
              selected={props.selected === tool().id}
              expanded={props.expanded[tool().id] === true}
            />
          )}
        </Match>
        <Match when={item("thinking")}>{(thinking) => <ThinkingRow item={thinking()} />}</Match>
        <Match when={turnEnds()}>{(parts) => <TurnEndRow parts={parts()} />}</Match>
      </Switch>
    </box>
  )
}

export function ChatView(props: ChatProps) {
  let scroll: ScrollBoxRenderable | undefined
  const rows = createMemo(() => buildRows(props.session))
  const rowIds = createMemo(() => rows().map((row) => row.id))
  const rowById = createMemo(() => new Map(rows().map((row) => [row.id, row])))
  const previousKind = createMemo(() => new Map(rows().map((row, index) => [row.id, rows()[index - 1]?.kind])))

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
        {(id) => (
          <Show when={rowById().get(id)}>
            {(row) => <RowView {...props} row={row()} previous={previousKind().get(id)} />}
          </Show>
        )}
      </For>
    </scrollbox>
  )
}
