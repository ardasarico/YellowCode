import { type MouseEvent, RGBA, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Index, Show } from "solid-js"
import type { SessionTitle } from "../session/titler.ts"
import type { Session, SessionInfo, Window } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { cut, cutPath, formatAgo, formatClock, formatSpan, formatUntil, wrapLines } from "./format.ts"
import { levelColor, ThirdBar } from "./meters.tsx"
import { shortName, toolPrefix } from "./mcp/servers.ts"
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
  width: number
  resizing: boolean
  onResizeStart: () => void
}

type Server = SessionInfo["mcpServers"][number]
type ServerStatus = { mark: string; color: RGBA; name: RGBA; word: string; problem: boolean; running: boolean }
type ServerActivity = { used: Set<string>; running: Set<string> }

function firstUserLine(session: Session): string {
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "user") return item.text.split("\n").find((line) => line.trim() !== "") ?? ""
  }
  return ""
}

// Escape sequences and other control characters would show as stray text.
const plain = (text: string) => Bun.stripANSI(text).replace(/\p{Cc}/gu, " ")

function serverActivity(session: Session): ServerActivity {
  const items = Object.values(session.byId)
  const tools = items.flatMap((item) => (item.kind === "tool" ? [item] : []))
  const waiting = new Set(
    items.flatMap((item) => (item.kind === "ask" && item.status === "pending" ? [item.toolUseId] : [])),
  )
  const used = new Set<string>()
  const running = new Set<string>()
  for (const server of session.info?.mcpServers ?? []) {
    const own = tools.filter((tool) => tool.name.startsWith(toolPrefix(server.name)))
    if (own.length > 0) used.add(server.name)
    if (own.some((tool) => tool.status === "running" && !waiting.has(tool.id))) running.add(server.name)
  }
  return { used, running }
}

function serverStatus(server: Server, activity: ServerActivity): ServerStatus {
  const base = { name: theme.text, word: "", problem: false, running: false }
  if (server.status === "failed") return { ...base, mark: "✕", color: theme.error, word: "failed", problem: true }
  if (server.status === "needs-auth")
    return { ...base, mark: "!", color: theme.warning, word: "needs login", problem: true }
  if (server.status === "disabled") return { ...base, mark: "–", color: theme.faint, name: theme.faint, word: "off" }
  if (server.status === "pending") return { ...base, mark: "◌", color: theme.accent }
  if (activity.running.has(server.name)) return { ...base, mark: "●", color: theme.accent, running: true }
  if (activity.used.has(server.name)) return { ...base, mark: "●", color: theme.muted }
  return { ...base, mark: "○", color: theme.faint, name: theme.faint }
}

// Problems lead and disabled servers trail.
const serverRank = (row: { server: Server; status: ServerStatus }) =>
  row.status.problem ? 0 : row.server.status === "disabled" ? 2 : 1

function resetTime(resetsAt: number, now: number): string {
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

function ServerRow(props: { server: Server; status: ServerStatus; width: number }) {
  const name = () => cut(shortName(props.server.name), props.width - 2)
  const room = () => props.width - 4 - Bun.stringWidth(name())
  const error = () => (props.server.status === "failed" ? props.server.error?.replace(/\s+/g, " ").trim() : "")
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

function Mcp(props: { session: Session; width: number }) {
  const [open, setOpen] = createSignal(false)
  const all = () => props.session.info?.mcpServers ?? []
  const servers = () => all().filter((server) => server.status !== "disabled")
  const activity = createMemo(() => serverActivity(props.session))
  // A closed section still lists problems and running servers.
  const rows = createMemo(() =>
    all()
      .map((server) => ({ server, status: serverStatus(server, activity()) }))
      .toSorted((a, b) => serverRank(a) - serverRank(b)),
  )
  const ok = () => servers().filter((server) => server.status === "connected").length
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

function Usage(props: { session: Session; model: string | null; width: number; now: number }) {
  const windows = () => {
    const limits = props.session.usage.limits
    const rows: { label: string; window: Window }[] = []
    if (limits.fiveHour) rows.push({ label: "5 hours", window: limits.fiveHour })
    if (limits.week) rows.push({ label: "week", window: limits.week })
    const family = /^claude-(opus|sonnet)/.exec(props.model ?? "")?.[1]
    const own = family ? limits.models[family] : undefined
    if (family && own) rows.push({ label: `${family.charAt(0).toUpperCase()}${family.slice(1)} week`, window: own })
    return rows
  }
  const spent = () => {
    const source = props.session.info?.apiKeySource
    if (windows().length > 0 || !source || source === "none" || source === "oauth") return null
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

export function Sidebar(props: SidebarProps) {
  const tick = useTicker(() => true, 30_000)
  const now = () => {
    tick()
    return Date.now()
  }
  const inner = () => props.width - 4
  const [hover, setHover] = createSignal(false)
  const edgeColor = () => {
    if (props.resizing) return theme.accent
    if (hover()) return theme.frame
    return theme.band ?? theme.frame
  }

  return (
    <box flexDirection="row" flexShrink={0} width={props.width} backgroundColor={theme.band ?? theme.canvas}>
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
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={2} paddingY={1} overflow="hidden">
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
          <Show when={(props.session.info?.mcpServers ?? []).some((server) => server.status !== "disabled")}>
            <Mcp session={props.session} width={inner()} />
          </Show>
        </box>
        <Usage session={props.session} model={props.model} width={inner()} now={now()} />
      </box>
    </box>
  )
}
