import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import type { SettingChange } from "../agent/settings.ts"
import type { Command } from "../input/commands.ts"
import { settings } from "../session/settings.ts"
import { shellNodeId } from "../session/shells.ts"
import type { Ask, Item, Session } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { AgentRow } from "./agent.tsx"
import { ConversationHeader } from "./conversation-header.tsx"
import { invertCells } from "./invert.ts"
import { EDGE_GAP } from "./layout.ts"
import { Markdown } from "./markdown/markdown.tsx"
import { refTarget } from "./markdown/refs.ts"
import { RewoundBand } from "./rewind/rewound-band.tsx"
import { ShellEndRow } from "./shell-end-row.tsx"
import { buildRows, foldRuns, REWOUND_ROW, type Row, RUN_SUFFIX } from "./structure.ts"
import { Divider, SystemRow } from "./system-row.tsx"
import { ThinkingRow } from "./thinking.tsx"
import { TodoRow } from "./todos/todo-row.tsx"
import { isPeerSend, PeerSendRow } from "./peer-send-row.tsx"
import { ToolCallRow } from "./tool-call.tsx"
import { ToolGroupRow, ToolRunRow } from "./tool-group.tsx"
import { TurnEndRow } from "./turn-end.tsx"
import { UserMessageRow } from "./user-message.tsx"
import type { Workspace } from "./welcome.tsx"

export type ScrollState = { atBottom: boolean; newLines: number }

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => b[index] === id)

type ChatProps = {
  session: Session
  commands: Command[]
  settingChange?: (text: string) => SettingChange | null
  width: number
  selected: string | null
  expanded: Record<string, boolean>
  onOverflow: (id: string, overflowing: boolean) => void
  onToggle: (id: string) => void
  onOpenAgent: (id: string) => void
  onOpenImage: (id: string) => void
  onOpenRef: (id: string) => void
  // Whether a running agent or workflow shows its progress in the agent panel instead of its chat row.
  docked: (id: string) => boolean
  // See `imagesBefore` in markdown/refs.ts.
  imagesBefore: (id: string) => number
}

type ChatViewProps = ChatProps & {
  rows: Accessor<Row[]>
  workspace: Workspace
  model: string | null
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
  // The row belongs to an open run of a finished turn.
  nested: boolean
  waiting: number
  viewport: () => Renderable | undefined
  // The height a row far off screen keeps while it draws nothing.
  frozen: number | undefined
  onBox: (box: Renderable) => void
}

function RowView(props: RowProps) {
  const item = <K extends Item["kind"]>(kind: K) => {
    const found = props.session.byId[props.row.id]
    return found && isKind(found, kind) ? found : undefined
  }
  const peerSend = () => {
    const tool = item("tool")
    return tool && isPeerSend(tool) ? tool : undefined
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
      ref={props.onBox}
      marginTop={gap()}
      paddingLeft={props.nested ? 2 : 0}
      height={props.frozen}
      renderAfter={function () {
        const id = props.selected
        if (!id || theme.selection !== null) return
        const row = props.row
        // A group's header and each call in it are selected on their own.
        if (row.kind === "group") {
          const part = id === row.id || row.members.includes(id) ? this.findDescendantById(id) : undefined
          if (part) invertCells(part, props.viewport())
        } else if (id === row.id)
          invertCells((props.nested ? this.findDescendantById(id) : undefined) ?? this, props.viewport())
        // A selected reference is reversed in its own text run.
        else if (id.startsWith(`${props.row.id}/`) && !refTarget(id)) {
          const label = this.findDescendantById(id)
          if (label) invertCells(label, props.viewport())
        }
      }}
    >
      <Show when={props.frozen === undefined}>
        <Switch>
          <Match when={item("user")}>
            {(user) => (
              <UserMessageRow
                item={user()}
                commands={props.commands}
                settingChange={props.settingChange}
                selected={props.selected === user().id}
                expanded={props.expanded[user().id] === true}
                selection={props.selected}
                onOverflow={props.onOverflow}
                onToggle={props.onToggle}
                onOpenImage={props.onOpenImage}
              />
            )}
          </Match>
          <Match when={props.row.kind === "tool" && peerSend()}>
            {(tool) => (
              <PeerSendRow
                item={tool()}
                selected={props.selected === tool().id}
                expanded={props.expanded[tool().id] === true}
              />
            )}
          </Match>
          <Match when={props.row.kind === "tool" && item("tool")?.toolKind === "todo" && item("tool")}>
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
          <Match when={props.row.kind === "run" ? props.row : undefined}>
            {(run) => (
              <ToolRunRow
                session={props.session}
                id={run().id}
                rows={run().rows}
                selected={props.selected === run().id}
                open={props.expanded[run().id] === true}
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
                docked={props.docked(tool().id)}
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
      </Show>
    </box>
  )
}

export const holdsSelection = (row: Row, selected: string | null) =>
  selected !== null &&
  (selected === row.id || selected.startsWith(`${row.id}/`) || (row.kind === "group" && row.members.includes(selected)))

const rowKeys = (rows: Row[]) => rows.map((row) => `${row.kind} ${row.id}`)

// A row keeps its object while it stays the same, so its view does not run again. The rows of a run in `expanded`
// follow it.
export function createRows(session: () => Session, expanded: Record<string, boolean>) {
  const built = createMemo((previous: Row[]) => {
    const old = new Map(previous.map((row) => [row.id, row]))
    const rows = buildRows(session())
    return (settings.finishedTurns === "fold" ? foldRuns(session(), rows) : rows).map((row) => {
      const kept = old.get(row.id)
      if (!kept || kept.kind !== row.kind) return row
      if (kept.kind === "end" && row.kind === "end") return sameIds(kept.turnEnds, row.turnEnds) ? kept : row
      if (kept.kind === "group" && row.kind === "group") return sameIds(kept.members, row.members) ? kept : row
      if (kept.kind === "run" && row.kind === "run") return sameIds(rowKeys(kept.rows), rowKeys(row.rows)) ? kept : row
      return kept
    })
  }, [])
  return createMemo(() =>
    built().flatMap((row) => {
      const rows: Row[] = [row]
      return row.kind === "run" && expanded[row.id] === true ? rows.concat(row.rows) : rows
    }),
  )
}

export function ChatView(props: ChatViewProps) {
  let scroll: ScrollBoxRenderable | undefined
  // The scroll height when the user left the bottom, so growth since then counts as new lines.
  let leftAtHeight: number | null = null
  let reachedTop = false
  let shifted = false
  const rowIds = createMemo(() => props.rows().map((row) => row.id))
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
  // Runs that fold above the lines the user reads leave those lines where they are: the first row in view is
  // measured before the change and put back in the same layout pass.
  let refolded: { box: Renderable | undefined; top: number } | null = null
  const runIds = createMemo(() => rowIds().filter((id) => id.endsWith(RUN_SUFFIX)), [], { equals: sameIds })
  createEffect(
    on(
      runIds,
      () => {
        refolded = null
        if (!scroll || shifted || scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height) return
        const edge = scroll.viewport.y
        // A row made just now sits at the top with no height, so it is never the one in view.
        const box = rowIds()
          .map((id) => boxes.get(id))
          .find((row) => row && row.y + row.height > edge)
        refolded = { box, top: (box?.y ?? 0) - scroll.content.y }
      },
      { defer: true },
    ),
  )
  const rowById = createMemo(() => new Map(props.rows().map((row) => [row.id, row])))
  const nested = createMemo(
    () => new Set(props.rows().flatMap((row) => (row.kind === "run" ? row.rows.map((inner) => inner.id) : []))),
  )
  const agentIndex = createMemo(
    () =>
      new Map(
        props
          .rows()
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
        (task) => task.kind === "agent" && task.background && task.parentId === null && task.state === "running",
      ).length,
  )
  // The end of the latest turn, unless a new message went out after it.
  const latestEnd = createMemo(() => {
    const index = props.rows().findLastIndex((row) => row.kind === "end" || row.kind === "user")
    return props.rows()[index]?.kind === "end" ? props.rows()[index]?.id : undefined
  })
  const previousKind = createMemo(
    () => new Map(props.rows().map((row, index) => [row.id, props.rows()[index - 1]?.kind])),
  )
  // A divider right above the prompt's rule reads as one block, so it gets a row of its own.
  const endsWithDivider = createMemo(() => {
    const last = props.rows().at(-1)
    const item = last?.kind === "system" ? props.session.byId[last.id] : undefined
    return item?.kind === "system" && item.level === "info"
  })

  // Every layout pass walks every node in the chat, so rows far off screen draw as an empty box of their height.
  // The turn still running and the selected row always draw.
  const boxes = new Map<string, Renderable>()
  const heights = new Map<string, number>()
  const [frozen, setFrozen] = createSignal<ReadonlySet<string>>(new Set())
  let lastView = ""
  createEffect(
    on(
      () => props.width,
      () => {
        heights.clear()
        setFrozen(new Set<string>())
      },
      { defer: true },
    ),
  )
  const turnStart = createMemo(() => props.rows().findLastIndex((row) => row.kind === "user"))
  // A selection in a frozen row, or in a row made just now, can only scroll into view once the row is laid out.
  let scrollToSelected: string | null = null
  let placingFrames = 0
  createEffect(
    on(
      () => props.selected,
      (id) => {
        scrollToSelected = null
        if (scroll) scroll.content.viewportCulling = true
        if (!id) return
        const row = props.rows().find((candidate) => holdsSelection(candidate, id))
        const placed = (scroll?.content.findDescendantById(id)?.height ?? 0) > 0
        if (row && scroll && (frozen().has(row.id) || !placed)) {
          scrollToSelected = id
          placingFrames = 0
          scroll.content.viewportCulling = false
          if (frozen().has(row.id)) setFrozen(new Set([...frozen()].filter((frozenId) => frozenId !== row.id)))
        } else scroll?.scrollChildIntoView(id)
      },
    ),
  )

  function freezeFar(box: ScrollBoxRenderable): void {
    const view = `${box.scrollTop}:${box.scrollHeight}:${box.viewport.height}:${props.selected}:${props.rows().length}`
    if (view === lastView) return
    lastView = view
    const page = box.viewport.height
    const top = box.viewport.y
    const bottom = top + page
    const before = frozen()
    const next = new Set<string>()
    props.rows().forEach((row, index) => {
      const element = boxes.get(row.id)
      if (!element) return
      const isFrozen = before.has(row.id)
      if (!isFrozen) heights.set(row.id, element.height)
      if (index >= turnStart() || holdsSelection(row, props.selected)) return
      // A row draws again a page before it comes into view and stops two pages after it left, so scrolling back and
      // forth does not build it over and over.
      const margin = isFrozen ? page : 2 * page
      if (element.y + element.height < top - margin || element.y > bottom + margin) next.add(row.id)
    })
    if (next.size !== before.size || [...next].some((id) => !before.has(id))) setFrozen(next)
  }

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
          if (refolded) {
            const moved = refolded.box ? refolded.box.getComputedLayout().top - refolded.top : 0
            refolded = null
            element.scrollTo(element.scrollTop + moved)
            // Only what folded above the view was there when the user left the bottom.
            if (leftAtHeight !== null) leftAtHeight = Math.min(leftAtHeight + moved, element.scrollHeight)
            return
          }
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
        refolded = null
        // Rows off screen get no layout while the viewport culls them, so the one with the selection is placed in a
        // frame without culling.
        if (scrollToSelected) {
          placingFrames += 1
          if ((this.content.findDescendantById(scrollToSelected)?.height ?? 0) > 0 || placingFrames > 3) {
            this.scrollChildIntoView(scrollToSelected)
            scrollToSelected = null
            this.content.viewportCulling = true
          } else this.requestRender()
        }
        freezeFar(this)
      }}
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      paddingX={EDGE_GAP}
      verticalScrollbarOptions={{ visible: false }}
    >
      <Show when={props.session.conversation > 0}>
        <ConversationHeader workspace={props.workspace} model={props.model} width={props.width - 2 * EDGE_GAP} />
      </Show>
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
          onCleanup(() => {
            boxes.delete(id)
            heights.delete(id)
          })
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
                  nested={nested().has(id)}
                  waiting={id === latestEnd() ? waitingAgents() : 0}
                  viewport={() => scroll?.viewport}
                  frozen={frozen().has(id) ? heights.get(id) : undefined}
                  onBox={(box) => boxes.set(id, box)}
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
