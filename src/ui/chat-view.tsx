import { RGBA, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js"
import type { Ask, Item, Session } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { AgentRow } from "./agent.tsx"
import { invertCells } from "./invert.ts"
import { Markdown } from "./markdown/markdown.tsx"
import { buildRows, type Row } from "./structure.ts"
import { SystemRow } from "./system-row.tsx"
import { ThinkingRow } from "./thinking.tsx"
import { ToolCallRow } from "./tool-call.tsx"
import { TurnEndRow } from "./turn-end.tsx"
import { UserMessageRow } from "./user-message.tsx"

export type ScrollState = { atBottom: boolean; newLines: number }

type ChatProps = {
  session: Session
  width: number
  selected: string | null
  expanded: Record<string, boolean>
  onOverflow: (id: string, overflowing: boolean) => void
}

type ChatViewProps = ChatProps & {
  onScrollState: (state: ScrollState) => void
  scrollRef: (scroll: ScrollBoxRenderable) => void
}

function isKind<K extends Item["kind"]>(item: Item, kind: K): item is Extract<Item, { kind: K }> {
  return item.kind === kind
}

type RowProps = ChatProps & {
  row: Row
  ask: Ask | null
  previous: Row["kind"] | undefined
  agentIndex: number
  viewport: () => Renderable | undefined
}

function RowView(props: RowProps) {
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
    return props.previous === "end" ? 2 : 1
  }

  return (
    <box
      marginTop={gap()}
      renderAfter={function (buffer) {
        if (props.selected === props.row.id && theme.selection === null) invertCells(this, buffer, props.viewport())
      }}
    >
      <Switch>
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
              ask={props.ask}
              cwd={props.session.info?.cwd ?? ""}
              selected={props.selected === tool().id}
              expanded={props.expanded[tool().id] === true}
            />
          )}
        </Match>
        <Match when={props.row.kind === "agent" ? item("tool") : undefined}>
          {(tool) => (
            <AgentRow
              item={tool()}
              index={props.agentIndex}
              session={props.session}
              selected={props.selected === tool().id}
              expanded={props.expanded[tool().id] === true}
            />
          )}
        </Match>
        <Match when={item("text")}>
          {(text) => (
            <box>
              <Markdown markdown={text().markdown} streaming={text().streaming} width={props.width - 2} />
            </box>
          )}
        </Match>
        <Match when={item("system")}>{(system) => <SystemRow item={system()} />}</Match>
        <Match when={item("thinking")}>{(thinking) => <ThinkingRow item={thinking()} />}</Match>
        <Match when={turnEnds()}>{(parts) => <TurnEndRow parts={parts()} />}</Match>
      </Switch>
    </box>
  )
}

export function ChatView(props: ChatViewProps) {
  let scroll: ScrollBoxRenderable | undefined
  // The scroll height when the user left the bottom, so growth since then counts as new lines.
  let leftAtHeight: number | null = null
  const rows = createMemo(() => buildRows(props.session))
  const rowIds = createMemo(() => rows().map((row) => row.id))
  const rowById = createMemo(() => new Map(rows().map((row) => [row.id, row])))
  const agentIndex = createMemo(
    () =>
      new Map(
        rows()
          .filter((row) => row.kind === "agent")
          .map((row, index) => [row.id, index]),
      ),
  )
  const askByTool = createMemo(() => {
    const asks = new Map<string, Ask>()
    for (const id of props.session.items) {
      const item = props.session.byId[id]
      if (item?.kind === "ask") asks.set(item.toolUseId, item)
    }
    return asks
  })
  const previousKind = createMemo(() => new Map(rows().map((row, index) => [row.id, rows()[index - 1]?.kind])))

  createEffect(() => {
    const id = props.selected
    if (id) scroll?.scrollChildIntoView(id)
  })

  return (
    <scrollbox
      ref={(element) => {
        scroll = element
        props.scrollRef(element)
      }}
      renderAfter={function () {
        const atBottom = this.scrollTop >= this.scrollHeight - this.viewport.height
        leftAtHeight = atBottom ? null : (leftAtHeight ?? this.scrollHeight)
        props.onScrollState({ atBottom, newLines: this.scrollHeight - (leftAtHeight ?? this.scrollHeight) })
      }}
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
            {(row) => (
              <RowView
                {...props}
                row={row()}
                ask={askByTool().get(id) ?? null}
                previous={previousKind().get(id)}
                agentIndex={agentIndex().get(id) ?? 0}
                viewport={() => scroll?.viewport}
              />
            )}
          </Show>
        )}
      </For>
    </scrollbox>
  )
}
