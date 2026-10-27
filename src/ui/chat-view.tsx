import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, Match, on, Show, Switch } from "solid-js"
import type { Command } from "../input/commands.ts"
import { shellNodeId } from "../session/shells.ts"
import type { Ask, Item, Session } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { AgentRow } from "./agent.tsx"
import { invertCells } from "./invert.ts"
import { EDGE_GAP } from "./layout.ts"
import { Markdown } from "./markdown/markdown.tsx"
import { refTarget } from "./markdown/refs.ts"
import { RewoundBand } from "./rewind/rewound-band.tsx"
import { ShellEndRow } from "./shell-end-row.tsx"
import { buildRows, REWOUND_ROW, type Row } from "./structure.ts"
import { Divider, SystemRow } from "./system-row.tsx"
import { ThinkingRow } from "./thinking.tsx"
import { TODO_TOOLS } from "../session/todos.ts"
import { TodoRow } from "./todos/todo-row.tsx"
import { ToolCallRow } from "./tool-call.tsx"
import { ToolGroupRow } from "./tool-group.tsx"
import { TurnEndRow } from "./turn-end.tsx"
import { UserMessageRow } from "./user-message.tsx"

export type ScrollState = { atBottom: boolean; newLines: number }

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => b[index] === id)

type ChatProps = {
  session: Session
  commands: Command[]
  width: number
  selected: string | null
  expanded: Record<string, boolean>
  onOverflow: (id: string, overflowing: boolean) => void
  onToggle: (id: string) => void
  onOpenAgent: (id: string) => void
  onOpenImage: (id: string) => void
  onOpenRef: (id: string) => void
  // See `imagesBefore` in markdown/refs.ts.
  imagesBefore: (id: string) => number
}

type ChatViewProps = ChatProps & {
  earlier: boolean
  onReachTop: () => void
  onScrollState: (state: ScrollState) => void
  scrollRef: (scroll: ScrollBoxRenderable) => void
  onRedo: () => void
}

function isKind<K extends Item["kind"]>(item: Item, kind: K): item is Extract<Item, { kind: K }> {
  return item.kind === kind
}

type RowProps = ChatProps & {
  row: Row
  ask: Ask | null
  askOf: (id: string) => Ask | null
  previous: Row["kind"] | undefined
  agentIndex: number
  waiting: number
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
  const openShell = (taskId: string) => props.onOpenAgent(shellNodeId(taskId))
  const gap = () => (props.previous === "end" && props.row.kind === "user" ? 2 : 1)

  return (
    <box
      marginTop={gap()}
      renderAfter={function () {
        const id = props.selected
        if (!id || theme.selection !== null) return
        const row = props.row
        // A group's header and each call in it are selected on their own.
        if (row.kind === "group") {
          const part = id === row.id || row.members.includes(id) ? this.findDescendantById(id) : undefined
          if (part) invertCells(part, props.viewport())
        } else if (id === row.id) invertCells(this, props.viewport())
        // A selected reference is reversed in its own text run.
        else if (id.startsWith(`${props.row.id}/`) && !refTarget(id)) {
          const label = this.findDescendantById(id)
          if (label) invertCells(label, props.viewport())
        }
      }}
    >
      <Switch>
        <Match when={item("user")}>
          {(user) => (
            <UserMessageRow
              item={user()}
              commands={props.commands}
              selected={props.selected === user().id}
              expanded={props.expanded[user().id] === true}
              selection={props.selected}
              onOverflow={props.onOverflow}
              onToggle={props.onToggle}
              onOpenImage={props.onOpenImage}
            />
          )}
        </Match>
        <Match when={props.row.kind === "tool" && TODO_TOOLS.has(item("tool")?.name ?? "") && item("tool")}>
          {(tool) => <TodoRow session={props.session} item={tool()} selected={props.selected === tool().id} />}
        </Match>
        <Match when={(props.row.kind === "tool" || props.row.kind === "brief") && item("tool")}>
          {(tool) => (
            <ToolCallRow
              item={tool()}
              ask={props.ask}
              task={props.session.tasks[tool().taskId ?? ""]}
              cwd={props.session.info?.cwd ?? ""}
              selected={props.selected === tool().id}
              expanded={props.expanded[tool().id] === true}
              selection={props.selected}
              brief={props.row.kind === "brief"}
              onToggle={props.onToggle}
              onOpenShell={openShell}
              onOpenImage={props.onOpenImage}
            />
          )}
        </Match>
        <Match when={props.row.kind === "group" ? props.row : undefined}>
          {(group) => (
            <ToolGroupRow
              session={props.session}
              id={group().id}
              members={group().members}
              cwd={props.session.info?.cwd ?? ""}
              selection={props.selected}
              expanded={props.expanded}
              askOf={props.askOf}
              onToggle={props.onToggle}
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
              onOpen={props.onOpenAgent}
            />
          )}
        </Match>
        <Match when={item("text")}>
          {(text) => (
            <box>
              <Markdown
                markdown={text().markdown}
                streaming={text().streaming}
                width={props.width}
                chat={{
                  itemId: text().id,
                  selection: props.selected,
                  expanded: props.expanded,
                  images: props.imagesBefore(text().id),
                  onOpenImage: props.onOpenImage,
                  onOpenRef: props.onOpenRef,
                  onToggle: props.onToggle,
                }}
              />
            </box>
          )}
        </Match>
        <Match when={item("system")}>{(system) => <SystemRow item={system()} />}</Match>
        <Match when={item("thinking")}>
          {(thinking) => (
            <ThinkingRow
              item={thinking()}
              selected={props.selected === thinking().id}
              expanded={props.expanded[thinking().id] === true}
              onToggle={props.onToggle}
            />
          )}
        </Match>
        <Match when={item("shell-end")}>
          {(end) => <ShellEndRow session={props.session} item={end()} onOpen={openShell} />}
        </Match>
        <Match when={turnEnds()}>{(parts) => <TurnEndRow parts={parts()} waiting={props.waiting} />}</Match>
      </Switch>
    </box>
  )
}

export function ChatView(props: ChatViewProps) {
  let scroll: ScrollBoxRenderable | undefined
  // The scroll height when the user left the bottom, so growth since then counts as new lines.
  let leftAtHeight: number | null = null
  let reachedTop = false
  let shifted = false
  // A row keeps its object while it stays the same, so its view does not run again.
  const rows = createMemo((previous: Row[]) => {
    const old = new Map(previous.map((row) => [row.id, row]))
    return buildRows(props.session).map((row) => {
      const kept = old.get(row.id)
      if (!kept || kept.kind !== row.kind) return row
      if (kept.kind === "end" && row.kind === "end") return sameIds(kept.turnEnds, row.turnEnds) ? kept : row
      if (kept.kind === "group" && row.kind === "group") return sameIds(kept.members, row.members) ? kept : row
      return kept
    })
  }, [])
  const rowIds = createMemo(() => rows().map((row) => row.id))
  createEffect(
    on(rowIds, (ids, previous) => {
      const first = previous?.[0]
      if (first !== undefined && ids[0] !== first && ids.includes(first)) shifted = true
    }),
  )
  createEffect(
    on(
      () => props.earlier,
      () => (shifted = true),
      { defer: true },
    ),
  )
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
  const waitingAgents = createMemo(
    () =>
      Object.values(props.session.tasks).filter(
        (task) => task.type === "local_agent" && task.background && task.parentId === null && task.state === "running",
      ).length,
  )
  // The end of the latest turn, unless a new message went out after it.
  const latestEnd = createMemo(() => {
    const index = rows().findLastIndex((row) => row.kind === "end" || row.kind === "user")
    return rows()[index]?.kind === "end" ? rows()[index]?.id : undefined
  })
  const previousKind = createMemo(() => new Map(rows().map((row, index) => [row.id, rows()[index - 1]?.kind])))
  // A divider right above the prompt's rule reads as one block, so it gets a row of its own.
  const endsWithDivider = createMemo(() => {
    const last = rows().at(-1)
    const item = last?.kind === "system" ? props.session.byId[last.id] : undefined
    return item?.kind === "system" && item.level === "info"
  })

  createEffect(() => {
    const id = props.selected
    if (id) scroll?.scrollChildIntoView(id)
  })

  return (
    <scrollbox
      ref={(element) => {
        scroll = element
        props.scrollRef(element)
        // Rows added or removed at the front keep the visible rows in place, in the same layout pass.
        const resized = element.content.onSizeChange
        element.content.onSizeChange = () => {
          const before = element.scrollHeight
          resized?.()
          if (!shifted) return
          reachedTop = false
          const delta = element.scrollHeight - before
          element.scrollTo(element.scrollTop + delta)
          if (leftAtHeight !== null) leftAtHeight += delta
        }
      }}
      renderAfter={function () {
        if (props.earlier && this.scrollTop === 0 && !reachedTop) {
          reachedTop = true
          props.onReachTop()
        }
        const atBottom = this.scrollTop >= this.scrollHeight - this.viewport.height
        leftAtHeight = atBottom ? null : (leftAtHeight ?? this.scrollHeight)
        props.onScrollState({ atBottom, newLines: this.scrollHeight - (leftAtHeight ?? this.scrollHeight) })
        shifted = false
      }}
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingX={EDGE_GAP}
      verticalScrollbarOptions={{ visible: false }}
    >
      <Show when={props.earlier}>
        <box marginTop={1}>
          <Divider text="earlier conversation" />
        </box>
      </Show>
      <For each={rowIds()}>
        {(id) => {
          if (id === REWOUND_ROW)
            return (
              <Show when={props.session.rewound}>
                {(rewound) => <RewoundBand rewound={rewound()} onRedo={props.onRedo} />}
              </Show>
            )
          const ask = createMemo(() => askByTool().get(id) ?? null)
          const previous = createMemo(() => previousKind().get(id))
          const index = createMemo(() => agentIndex().get(id) ?? 0)
          return (
            <Show when={rowById().get(id)}>
              {(row) => (
                <RowView
                  {...props}
                  width={props.width - 2 * EDGE_GAP}
                  row={row()}
                  ask={ask()}
                  askOf={(tool) => askByTool().get(tool) ?? null}
                  previous={previous()}
                  agentIndex={index()}
                  waiting={id === latestEnd() ? waitingAgents() : 0}
                  viewport={() => scroll?.viewport}
                />
              )}
            </Show>
          )
        }}
      </For>
      <Show when={endsWithDivider()}>
        <box height={1} flexShrink={0} />
      </Show>
    </scrollbox>
  )
}
