import { type MouseEvent, RGBA, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Index, Show } from "solid-js"
import type { SessionTitle } from "../session/titler.ts"
import type { Agent, Session, SessionInfo, Window } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { AgentMark } from "./figures.tsx"
import { cut, cutPath, formatClock, formatSpan, formatUntil } from "./format.ts"
import { levelColor, ThirdBar } from "./meters.tsx"
import { useTicker } from "./ticker.ts"
import type { Workspace } from "./welcome.tsx"

const MAX_AGENTS = 5
const SECTION_GAP = 1
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const DAY_MS = 86_400_000

export type SidebarProps = {
  session: Session
  title: SessionTitle | null
  workspace: Workspace
  model: string | null
  width: number
  overlay: boolean
  resizing: boolean
  onResizeStart: () => void
  onJump: (id: string) => void
}

type SidebarAgent = { id: string; agent: Agent; color: RGBA }
type Server = SessionInfo["mcpServers"][number]
type ServerStatus = { word: string; color: RGBA; problem: boolean }

// The visible agents are the running ones plus those started since the latest user message.
function visibleAgents(session: Session): SidebarAgent[] {
  const agents: (SidebarAgent & { afterUser: boolean })[] = []
  let order = 0
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "user") for (const agent of agents) agent.afterUser = false
    if (item?.kind !== "tool" || (!item.agent && item.name !== "Agent")) continue
    const color = theme.agents[order % theme.agents.length] ?? theme.accent
    order += 1
    if (item.agent) agents.push({ id, agent: item.agent, color, afterUser: true })
  }
  const visible = agents.filter((entry) => entry.afterUser || entry.agent.state === "running")
  return [
    ...visible.filter((entry) => entry.agent.state === "running"),
    ...visible.filter((entry) => entry.agent.state !== "running"),
  ]
}

function firstUserLine(session: Session): string {
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "user") return item.text.split("\n").find((line) => line.trim() !== "") ?? ""
  }
  return ""
}

function wrapLines(text: string, width: number, max: number): string[] {
  const lines: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1)
    if (last !== undefined && Bun.stringWidth(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  if (lines.length > max) lines.splice(max - 1, lines.length, lines.slice(max - 1).join(" "))
  return lines.map((line) => cut(line, width).replace(/\s+…$/, "…"))
}

// MCP tool names carry the server name with every character outside [A-Za-z0-9_-] replaced by `_`.
const toolPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`

function serversInUse(session: Session): Set<string> {
  const running = Object.values(session.byId).flatMap((item) =>
    item.kind === "tool" && item.status === "running" ? [item.name] : [],
  )
  const servers = session.info?.mcpServers ?? []
  return new Set(
    servers.filter((server) => running.some((name) => name.startsWith(toolPrefix(server.name)))).map((s) => s.name),
  )
}

function serverStatus(server: Server, inUse: boolean): ServerStatus {
  if (server.status === "failed")
    return { word: server.error?.replace(/\s+/g, " ") ?? "failed", color: theme.error, problem: true }
  if (server.status === "needs-auth") return { word: "needs login", color: theme.warning, problem: true }
  if (inUse) return { word: "in use", color: theme.accent, problem: false }
  return { word: server.status, color: theme.muted, problem: false }
}

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
  width: number
  now: number
}) {
  const span = () => {
    const started = props.session.usage.startedAt
    return started === null ? "" : formatSpan(props.now - started)
  }
  const description = () => wrapLines(props.title?.summary ?? firstUserLine(props.session), props.width, 2)
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={1}>
          {cut(props.title?.title ?? "Session", Math.max(1, props.width - span().length - 2))}
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

function Heading(props: { left: string; right: string; onMouseDown?: (event: MouseEvent) => void; extra?: string }) {
  return (
    <box flexDirection="row" justifyContent="space-between" onMouseDown={(event) => props.onMouseDown?.(event)}>
      <text wrapMode="none" flexShrink={1}>
        <span style={{ fg: theme.text, bold: true }}>{props.left}</span>
        <Show when={props.extra}>{(extra) => <span style={{ fg: theme.accent }}>{`  ● ${extra()}`}</span>}</Show>
      </text>
      <text fg={theme.faint} wrapMode="none" flexShrink={0}>
        {props.right}
      </text>
    </box>
  )
}

function Subagents(props: { agents: SidebarAgent[]; width: number; onJump: (id: string) => void }) {
  const shown = () => props.agents.slice(0, MAX_AGENTS)
  const running = () => props.agents.filter((entry) => entry.agent.state === "running").length
  const nameColor = (entry: SidebarAgent) => {
    if (entry.agent.state === "running") return entry.color
    if (entry.agent.state === "completed") return theme.text
    return theme.error
  }
  return (
    <box flexDirection="column" marginTop={SECTION_GAP} flexShrink={0}>
      <Heading left="Subagents" right={`${running()}/${props.agents.length}`} />
      <Index each={shown()}>
        {(entry) => (
          <box
            flexDirection="column"
            onMouseDown={(event) => {
              event.preventDefault()
              props.onJump(entry().id)
            }}
          >
            <box flexDirection="row">
              <AgentMark
                color={entry().color}
                state={entry().agent.state}
                size="small"
                background={theme.band ?? theme.background}
              />
              <text fg={nameColor(entry())} wrapMode="none">
                {` ${cut(entry().agent.name, props.width - 2)}`}
              </text>
            </box>
            <text wrapMode="none">
              <span style={{ fg: theme.frame }}>{" ╰─ "}</span>
              <span style={{ fg: theme.muted }}>{cut(entry().agent.task, props.width - 4)}</span>
            </text>
          </box>
        )}
      </Index>
      <Show when={props.agents.length > MAX_AGENTS}>
        <text fg={theme.faint} wrapMode="none">{`+${props.agents.length - MAX_AGENTS} more`}</text>
      </Show>
    </box>
  )
}

function ServerRow(props: { server: Server; status: ServerStatus; width: number }) {
  const name = () => cut(props.server.name, props.width - 2)
  return (
    <text wrapMode="none">
      <span style={{ fg: props.status.color }}>{"● "}</span>
      <span style={{ fg: theme.text }}>{name()}</span>
      <span
        style={{ fg: props.status.color }}
      >{`  ${cut(props.status.word, Math.max(1, props.width - 4 - Bun.stringWidth(name())))}`}</span>
    </text>
  )
}

function Mcp(props: { session: Session; width: number }) {
  const [open, setOpen] = createSignal(false)
  const servers = () => (props.session.info?.mcpServers ?? []).filter((server) => server.status !== "disabled")
  const rows = createMemo(() => {
    const inUse = serversInUse(props.session)
    const all = servers().map((server) => ({ server, status: serverStatus(server, inUse.has(server.name)) }))
    return [...all.filter((row) => row.status.problem), ...all.filter((row) => !row.status.problem)]
  })
  const ok = () => servers().filter((server) => server.status === "connected").length
  const busy = () => (open() ? undefined : rows().find((row) => row.status.word === "in use")?.server.name)
  const listed = () => (open() ? rows() : rows().filter((row) => row.status.problem))
  return (
    <box flexDirection="column" marginTop={SECTION_GAP} flexShrink={0}>
      <Heading
        left={open() ? "▾ MCP" : "▸ MCP"}
        extra={busy()}
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
          {(row, index) => (
            <box flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text} wrapMode="none">
                  {row().label}
                </text>
                <text fg={levelColor(row().window.utilization)} wrapMode="none">
                  {`${100 - Math.round(row().window.utilization * 100)}% left`}
                </text>
              </box>
              <ThirdBar
                fraction={row().window.utilization}
                width={props.width}
                color={levelColor(row().window.utilization)}
              />
              <text fg={theme.muted} wrapMode="none">
                {cut(
                  `↻  ${formatUntil(row().window.resetsAt - props.now)} · ${resetTime(row().window.resetsAt, props.now)}`,
                  props.width,
                )}
              </text>
            </box>
          )}
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
  const agents = createMemo(() => visibleAgents(props.session))
  const [hover, setHover] = createSignal(false)
  const edgeColor = () => {
    if (props.resizing) return theme.accent
    if (hover()) return theme.frame
    return theme.band ?? theme.frame
  }

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      width={props.width}
      backgroundColor={theme.band ?? theme.background ?? RGBA.defaultBackground()}
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
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={2} paddingY={1} overflow="hidden">
        <Title session={props.session} workspace={props.workspace} title={props.title} width={inner()} now={now()} />
        {/* On a short terminal the middle sections are clipped first, so usage stays pinned to the bottom. */}
        <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={SECTION_GAP} overflow="hidden">
          <Show when={agents().length > 0}>
            <Subagents agents={agents()} width={inner()} onJump={props.onJump} />
          </Show>
          <Show when={(props.session.info?.mcpServers ?? []).some((server) => server.status !== "disabled")}>
            <Mcp session={props.session} width={inner()} />
          </Show>
        </box>
        <Usage session={props.session} model={props.model} width={inner()} now={now()} />
      </box>
    </box>
  )
}
