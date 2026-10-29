import { type MouseEvent, RGBA, TextAttributes } from "@opentui/core"
import type { Capabilities } from "../agent/capabilities.ts"
import type { McpServerRow } from "../agent/lists.ts"
import { createComponent, createMemo, createSignal, ErrorBoundary, For, Index, Show, untrack } from "solid-js"
import type { ModSidebarZone } from "../mods/api.ts"
import { DEFAULT_SECTION_ORDER, modSections, type RegisteredSection, reportModError } from "../mods/registry.ts"
import type { SessionTitle } from "../session/titler.ts"
import type { Session, Window } from "../session/types.ts"
import { shownText } from "../session/agent-message.ts"
import { type Todo, todoList } from "../session/todos.ts"
import { todoMark } from "./todos/todo-row.tsx"
import { theme } from "../theme/theme.ts"
import { cut, cutPath, formatAgo, formatClock, formatSpan, formatUntil, plain, wrapLines } from "./format.ts"
import { EDGE_GAP, SIDEBAR_GAP } from "./layout.ts"
import { levelColor, ThirdBar } from "./meters.tsx"
import { useTicker } from "./ticker.ts"
import type { Workspace } from "./welcome.tsx"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const SECTION_GAP = 1
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const DAY_MS = 86_400_000

export type SidebarProps = {
  session: Session
  title: SessionTitle | null
  workspace: Workspace
  // A transcript opened read-only shows its age, like the session list, instead of the running time.
  modified?: number
  model: string | null
  // The session's MCP servers; null before the agent lists them.
  servers: McpServerRow[] | null
  caps: Pick<Capabilities, "limits" | "cost">
  width: number
  overlay: boolean
  resizing: boolean
  onResizeStart: () => void
}

type ServerStatus = { mark: string; color: RGBA; name: RGBA; word: string; problem: boolean; running: boolean }
type ServerActivity = { used: Set<string>; running: Set<string> }

function firstUserLine(session: Session): string {
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "user")
      return (
        shownText(item)
          .split("\n")
          .find((line) => line.trim() !== "") ?? ""
      )
  }
  return ""
}

function serverActivity(session: Session, servers: McpServerRow[]): ServerActivity {
  const items = Object.values(session.byId)
  const tools = items.flatMap((item) => (item.kind === "tool" ? [item] : []))
  const waiting = new Set(
    items.flatMap((item) => (item.kind === "ask" && item.status === "pending" ? [item.toolUseId] : [])),
  )
  const used = new Set<string>()
  const running = new Set<string>()
  for (const server of servers) {
    const own = tools.filter((tool) => tool.server === server.toolServer)
    if (own.length > 0) used.add(server.name)
    if (own.some((tool) => tool.status === "running" && !waiting.has(tool.id))) running.add(server.name)
  }
  return { used, running }
}

function serverStatus(server: McpServerRow, activity: ServerActivity): ServerStatus {
  const base = { name: theme.text, word: "", problem: false, running: false }
  if (server.state === "failed") return { ...base, mark: "✕", color: theme.error, word: "failed", problem: true }
  if (server.state === "needs-login")
    return { ...base, mark: "!", color: theme.warning, word: "needs login", problem: true }
  if (server.state === "off") return { ...base, mark: "–", color: theme.faint, name: theme.faint, word: "off" }
  if (server.state === "connecting") return { ...base, mark: "◌", color: theme.accent }
  if (activity.running.has(server.name)) return { ...base, mark: "●", color: theme.accent, running: true }
  if (activity.used.has(server.name)) return { ...base, mark: "●", color: theme.muted }
  return { ...base, mark: "○", color: theme.faint, name: theme.faint }
}

// Problems lead and disabled servers trail.
const serverRank = (row: { server: McpServerRow; status: ServerStatus }) =>
  row.status.problem ? 0 : row.server.state === "off" ? 2 : 1

export function resetTime(resetsAt: number, now: number): string {
  const clock = formatClock(resetsAt)
  return resetsAt - now < DAY_MS ? clock : `${WEEKDAYS[new Date(resetsAt).getDay()]} ${clock}`
}

function Rule(props: { width: number }) {
  return (
    <text fg={theme.frame} wrapMode="none">
      {"─".repeat(Math.max(0, props.width))}
    </text>
  )
}

function Directory(props: { workspace: Workspace; width: number }) {
  const branch = () => (props.workspace.branch ? ` · ${props.workspace.branch}` : "")
  const path = () => cutPath(props.workspace.cwd, Math.max(1, props.width - Bun.stringWidth(branch())))
  return (
    <text fg={theme.faint} wrapMode="none">
      {cut(`${path()}${branch()}`, props.width)}
    </text>
  )
}

function Title(props: {
  session: Session
  workspace: Workspace
  title: SessionTitle | null
  modified: number | undefined
  width: number
  now: number
}) {
  const span = () => {
    if (props.modified !== undefined) return formatAgo(props.modified, props.now)
    const started = props.session.usage.startedAt
    return started === null ? "" : formatSpan(props.now - started)
  }
  const description = () => {
    const text = plain(props.title?.summary || firstUserLine(props.session))
    return text === plain(props.title?.title ?? "") ? [] : wrapLines(text, props.width, 2)
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={1}>
          {cut(plain(props.title?.title ?? "Session"), Math.max(1, props.width - span().length - 2))}
        </text>
        <text fg={theme.muted} wrapMode="none" flexShrink={0}>
          {span()}
        </text>
      </box>
      <Index each={description()}>
        {(line) => (
          <text fg={theme.text} wrapMode="none">
            {line()}
          </text>
        )}
      </Index>
      <Directory workspace={props.workspace} width={props.width} />
      <Rule width={props.width} />
    </box>
  )
}

function Heading(props: { left: string; right: string; onMouseDown?: (event: MouseEvent) => void }) {
  const [hovered, setHovered] = createSignal(false)
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={hovered() && props.onMouseDown ? (theme.tile ?? CLEAR) : CLEAR}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => props.onMouseDown?.(event)}
    >
      <text wrapMode="none" flexShrink={1}>
        <span style={{ fg: theme.text, bold: true }}>{props.left}</span>
      </text>
      <text fg={theme.faint} wrapMode="none" flexShrink={0}>
        {props.right}
      </text>
    </box>
  )
}

function ServerRow(props: { server: McpServerRow; status: ServerStatus; width: number }) {
  const name = () => cut(props.server.label, props.width - 2)
  const room = () => props.width - 4 - Bun.stringWidth(name())
  const error = () => (props.server.state === "failed" ? props.server.error?.replace(/\s+/g, " ").trim() : "")
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span style={{ fg: props.status.color }}>{`${props.status.mark} `}</span>
        <span style={{ fg: props.status.name }}>{name()}</span>
        <span style={{ fg: props.status.color }}>
          {props.status.word && room() > 0 ? `  ${cut(props.status.word, room())}` : ""}
        </span>
      </text>
      <Show when={error()}>
        {(text) => (
          <text fg={theme.error} attributes={TextAttributes.DIM} wrapMode="none">
            {`  ${cut(text(), props.width - 2)}`}
          </text>
        )}
      </Show>
    </box>
  )
}

function Mcp(props: { session: Session; servers: McpServerRow[]; width: number }) {
  const [open, setOpen] = createSignal(false)
  const all = () => props.servers
  const servers = () => all().filter((server) => server.state !== "off")
  const activity = createMemo(() => serverActivity(props.session, all()))
  // A closed section still lists problems and running servers.
  const rows = createMemo(() =>
    all()
      .map((server) => ({ server, status: serverStatus(server, activity()) }))
      .toSorted((a, b) => serverRank(a) - serverRank(b)),
  )
  const ok = () => servers().filter((server) => server.state === "connected").length
  const listed = () => (open() ? rows() : rows().filter((row) => row.status.problem || row.status.running))
  return (
    <box flexDirection="column" marginTop={SECTION_GAP} flexShrink={0}>
      <Heading
        left={open() ? "▾ MCP" : "▸ MCP"}
        right={`${ok()}/${servers().length}`}
        onMouseDown={(event) => {
          event.preventDefault()
          setOpen((value) => !value)
        }}
      />
      <Index each={listed()}>
        {(row) => <ServerRow server={row().server} status={row().status} width={props.width} />}
      </Index>
    </box>
  )
}

function Tasks(props: { todos: Todo[]; width: number }) {
  const [open, setOpen] = createSignal(true)
  const done = () => props.todos.filter((todo) => todo.state === "done").length
  return (
    <box flexDirection="column" marginTop={SECTION_GAP} flexShrink={0}>
      <Heading
        left={open() ? "▾ Tasks" : "▸ Tasks"}
        right={`${done()}/${props.todos.length}`}
        onMouseDown={(event) => {
          event.preventDefault()
          setOpen((value) => !value)
        }}
      />
      <Show when={open()}>
        <Index each={props.todos}>
          {(todo) => (
            <text wrapMode="none">
              <span style={{ fg: todoMark(todo().state).fg }}>{`${todoMark(todo().state).text} `}</span>
              <span style={{ fg: todo().state === "done" ? theme.muted : theme.text }}>
                {cut(todo().text, props.width - 2)}
              </span>
            </text>
          )}
        </Index>
      </Show>
    </box>
  )
}

function Usage(props: {
  session: Session
  model: string | null
  caps: Pick<Capabilities, "limits" | "cost">
  width: number
  now: number
}) {
  const windows = () => {
    const limits = props.session.usage.limits
    const rows: { label: string; window: Window }[] = []
    if (!props.caps.limits) return rows
    if (limits.fiveHour) rows.push({ label: "5 hours", window: limits.fiveHour })
    if (limits.week) rows.push({ label: "week", window: limits.week })
    const family = /^claude-(opus|sonnet)/.exec(props.model ?? "")?.[1]
    const own = family ? limits.models[family] : undefined
    if (family && own) rows.push({ label: `${family.charAt(0).toUpperCase()}${family.slice(1)} week`, window: own })
    return rows
  }
  const spent = () => {
    const source = props.session.info?.apiKeySource
    if (!props.caps.cost || windows().length > 0 || source === "none") return null
    // An agent that names no sign-in shows its spend once there is any.
    if (!source && props.session.usage.costUsd <= 0) return null
    return `$${props.session.usage.costUsd.toFixed(2)} spent`
  }
  return (
    <Show when={windows().length > 0 || spent()}>
      <box flexDirection="column" flexShrink={0}>
        <Rule width={props.width} />
        <Show when={spent()}>{(text) => <text fg={theme.muted}>{text()}</text>}</Show>
        <Index each={windows()}>
          {(row, index) => {
            const used = () => Math.min(1, Math.max(0, row().window.utilization))
            return (
              <box flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text} wrapMode="none">
                    {row().label}
                  </text>
                  <text fg={levelColor(used())} wrapMode="none">
                    {`${100 - Math.round(used() * 100)}% left`}
                  </text>
                </box>
                <ThirdBar fraction={used()} width={props.width} color={levelColor(used())} />
                <text fg={theme.muted} wrapMode="none">
                  {cut(
                    `↻  ${formatUntil(row().window.resetsAt - props.now)} · ${resetTime(row().window.resetsAt, props.now)}`,
                    props.width,
                  )}
                </text>
              </box>
            )
          }}
        </Index>
      </box>
    </Show>
  )
}

// A mod's section: the app's heading over the mod's view. A throw in any of the mod's code turns the mod off.
function ModSection(props: { section: RegisteredSection; width: number; above: number; below: number }) {
  const mod = untrack(() => props.section.mod)
  return (
    <ErrorBoundary
      fallback={(error: unknown) => {
        queueMicrotask(() => reportModError(mod, error))
        return null
      }}
    >
      <Show when={props.section.visible?.() ?? true}>
        <box flexDirection="column" marginTop={props.above} marginBottom={props.below} flexShrink={0}>
          <Heading
            left={`${props.section.open() ? "▾" : "▸"} ${props.section.title}`}
            right={props.section.right?.() ?? ""}
            onMouseDown={(event) => {
              event.preventDefault()
              props.section.setOpen(!props.section.open())
            }}
          />
          <Show when={props.section.open()}>
            {createComponent(props.section.view, {
              get width() {
                return props.width
              },
            })}
          </Show>
        </box>
      </Show>
    </ErrorBoundary>
  )
}

const TASKS_ORDER = 10
const MCP_ORDER = 20

type BodyEntry = { order: number; builtin: "tasks" | "mcp" } | { order: number; section: RegisteredSection }

const zoneSections = (zone: ModSidebarZone) =>
  modSections()
    .filter((section) => (section.zone ?? "body") === zone)
    .toSorted((a, b) => (a.order ?? DEFAULT_SECTION_ORDER) - (b.order ?? DEFAULT_SECTION_ORDER))

export function Sidebar(props: SidebarProps) {
  const tick = useTicker(() => true, 30_000)
  const now = () => {
    tick()
    return Date.now()
  }
  const gap = () => (props.overlay ? 0 : SIDEBAR_GAP)
  const inner = () => props.width - gap() - 2 * EDGE_GAP
  const [hover, setHover] = createSignal(false)
  // Every section keeps its entry, so For does not remount the others when a mod section comes or goes.
  const builtins: BodyEntry[] = [
    { order: TASKS_ORDER, builtin: "tasks" },
    { order: MCP_ORDER, builtin: "mcp" },
  ]
  const entries = new WeakMap<RegisteredSection, BodyEntry>()
  const entryOf = (section: RegisteredSection) => {
    let entry = entries.get(section)
    if (!entry) entries.set(section, (entry = { order: section.order ?? DEFAULT_SECTION_ORDER, section }))
    return entry
  }
  const body = createMemo(() =>
    [...builtins, ...zoneSections("body").map(entryOf)].toSorted((a, b) => a.order - b.order),
  )
  const edgeColor = () => {
    if (props.resizing) return theme.accent
    if (hover() || props.overlay) return theme.frame
    return theme.band ?? theme.frame
  }

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      width={props.width - gap()}
      marginLeft={gap()}
      backgroundColor={theme.band ?? theme.canvas}
      position={props.overlay ? "absolute" : "relative"}
      right={0}
      top={0}
      height="100%"
      zIndex={1}
    >
      {/* With a band the edge line takes the fill's color and shows only on hover or while dragging; without a band
          it always marks the edge. */}
      <box
        width={1}
        border={["left"]}
        borderColor={edgeColor()}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          props.onResizeStart()
        }}
      />
      <box
        flexDirection="column"
        flexGrow={1}
        paddingLeft={EDGE_GAP - 1}
        paddingRight={EDGE_GAP}
        paddingY={1}
        overflow="hidden"
      >
        <For each={zoneSections("top")}>
          {(section) => <ModSection section={section} width={inner()} above={0} below={SECTION_GAP} />}
        </For>
        <Title
          session={props.session}
          workspace={props.workspace}
          title={props.title}
          modified={props.modified}
          width={inner()}
          now={now()}
        />
        {/* On a short terminal the middle sections are clipped first, so usage stays pinned to the bottom. */}
        <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={SECTION_GAP} overflow="hidden">
          <For each={body()}>
            {(entry) =>
              "section" in entry ? (
                <ModSection section={entry.section} width={inner()} above={SECTION_GAP} below={0} />
              ) : entry.builtin === "tasks" ? (
                <Show when={todoList(props.session).length > 0}>
                  <Tasks todos={todoList(props.session)} width={inner()} />
                </Show>
              ) : (
                <Show when={(props.servers ?? []).some((server) => server.state !== "off")}>
                  <Mcp session={props.session} servers={props.servers ?? []} width={inner()} />
                </Show>
              )
            }
          </For>
        </box>
        <Usage session={props.session} model={props.model} caps={props.caps} width={inner()} now={now()} />
        <For each={zoneSections("bottom")}>
          {(section) => <ModSection section={section} width={inner()} above={SECTION_GAP} below={0} />}
        </For>
      </box>
    </box>
  )
}
