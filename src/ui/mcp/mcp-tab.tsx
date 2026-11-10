import { createMemo, createSignal } from "solid-js"
import type { Agent } from "../../agent/agent.ts"
import type { Capabilities } from "../../agent/capabilities.ts"
import type { McpConfig, McpServerRow, McpState } from "../../agent/lists.ts"
import type { SharedSession } from "../../mcp/handover.ts"
import { theme } from "../../theme/theme.ts"
import { blank, fact, header, names, title } from "../dialog/detail.ts"
import type { DialogItem, DialogRow, DialogSection } from "../dialog/list.ts"
import type { FooterAction } from "../dialog/list-view.tsx"
import type { TabApi } from "../dialog/tabbed-dialog.tsx"
import { TwoPane } from "../dialog/two-pane.tsx"
import { SAVED_NOTICE } from "../format.ts"
import type { Span } from "../notice.ts"
import { MCP_GROUPS, type McpEntry, mcpEntries } from "./servers.ts"

const MORE_TOOLS = "tools-more"

const look = (state: McpState) =>
  ({
    failed: { mark: "✕", word: "failed", color: theme.error },
    "needs-login": { mark: "!", word: "needs login", color: theme.warning },
    connecting: { mark: "◌", word: "connecting", color: theme.accent },
    connected: { mark: "", word: "connected", color: theme.text },
    off: { mark: "", word: "off", color: theme.panelFaint },
    unknown: { mark: "", word: "unknown", color: theme.panelMuted },
  })[state]

const toolCount = (count: number) => (count === 1 ? "1 tool" : `${count} tools`)
const reconnects = (state: McpState) => state !== "needs-login" && state !== "off"

function problemRow(entry: McpEntry, problem: string): DialogRow {
  const color = entry.attention ? theme.warning : theme.panelFaint
  return {
    id: entry.id,
    label: entry.row.label,
    tag: entry.tag,
    search: `${entry.row.label} ${entry.tag}`,
    marker: entry.attention ? { text: "!", fg: color } : undefined,
    labelColor: entry.attention ? undefined : theme.panelFaint,
    value: problem,
    valueColor: color,
  }
}

function listRow(entry: McpEntry): DialogRow {
  if (entry.problem !== null) return problemRow(entry, entry.problem)
  const { state, label } = entry.row
  const { mark, word, color } = look(state)
  const row: DialogRow = {
    id: entry.id,
    label,
    tag: entry.tag,
    search: `${label} ${entry.tag}`,
    marker: mark ? { text: mark, fg: color } : undefined,
    labelColor: state === "off" ? theme.panelFaint : undefined,
    valueColor: color,
  }
  // The agent says nothing of a server it was handed and does not list.
  if (entry.kind === "handed") return { ...row, marker: undefined }
  // A server whose tools the agent does not list shows no count.
  if (state === "connected")
    return entry.row.tools === null
      ? row
      : { ...row, value: toolCount(entry.tools.length), valueColor: theme.panelFaint }
  if (state === "needs-login") return { ...row, selectedValue: word }
  return { ...row, value: word }
}

const listSections = (entries: McpEntry[]): DialogSection[] =>
  MCP_GROUPS.map(([group, heading]) => ({
    title: heading,
    rows: entries.filter((entry) => entry.group === group).map(listRow),
  })).filter((section) => section.rows.length > 0)

function entrySpan(entry: McpEntry): Span {
  if (entry.problem !== null)
    return entry.attention ? { text: "! off", fg: theme.warning } : { text: `◯ ${entry.problem}`, fg: theme.panelFaint }
  if (entry.kind === "handed") return { text: "◯ handed over", fg: theme.panelMuted }
  return stateSpan(entry.row.state)
}

function stateSpan(state: McpState): Span {
  const { mark, word, color } = look(state)
  if (state === "connected") return { text: `● ${word}`, fg: theme.success }
  if (state === "off" || state === "unknown") return { text: `◯ ${word}`, fg: color }
  return { text: `${mark} ${word}`, fg: color }
}

function shownConfig(config: McpConfig): [string, string] {
  if ("command" in config) return ["Command", [config.command, config.package].filter(Boolean).join(" ")]
  return ["URL", config.url]
}

function detailItems(entry: McpEntry, width: number, open: boolean): DialogItem[] {
  const config = entry.row.config ? shownConfig(entry.row.config) : null
  const tools =
    entry.tools.length > 0
      ? [
          blank("gap-tools"),
          title("tools", `Tools · ${entry.tools.length}`),
          ...names("tools", entry.tools, width, { open }),
        ]
      : []
  return [
    header(entry.row.label, entrySpan(entry)),
    blank("gap-head"),
    ...(entry.where ? fact("scope", "Scope", entry.where, width) : []),
    ...(entry.problem !== null && entry.attention
      ? fact("problem", "Problem", entry.problem, width, theme.warning)
      : []),
    ...(entry.row.error ? fact("error", "Error", entry.row.error, width, theme.error) : []),
    ...(config ? fact("config", config[0], config[1], width) : []),
    ...tools,
  ]
}

type McpCaps = Capabilities["mcp"]

function stateActions(state: McpState): DialogRow[] {
  const off = { id: "off", label: "Turn off" }
  if (state === "needs-login") return [{ id: "login", label: "Log in" }, off]
  if (state === "off") return [{ id: "on", label: "Turn on" }]
  if (state === "connecting") return [off]
  if (state === "connected") return [{ id: "restart", label: "Restart" }, off]
  return [{ id: "reconnect", label: "Reconnect" }, off]
}

const ACTION_CAP: Partial<Record<string, keyof McpCaps>> = {
  login: "login",
  on: "toggle",
  off: "toggle",
  restart: "reconnect",
  reconnect: "reconnect",
}

// A shared server is the agent's to reconnect or sign in to, not to switch off: whether it would stay off differs from
// agent to agent.
const toggles = (entry: McpEntry | undefined, can: McpCaps) => entry?.kind === "own" && can.toggle
const acts = (entry: McpEntry | undefined) => entry?.kind === "own" || entry?.kind === "shared"

const offeredActions = (entry: McpEntry | undefined, can: McpCaps) =>
  !entry || !acts(entry)
    ? []
    : stateActions(entry.row.state).filter((action) => {
        const cap = ACTION_CAP[action.id]
        if (cap === "toggle") return toggles(entry, can)
        return cap !== undefined && can[cap]
      })

const reconnectsHere = (entry: McpEntry | undefined, can: McpCaps) =>
  entry !== undefined && acts(entry) && can.reconnect && reconnects(entry.row.state)

function listFooter(entry: McpEntry | undefined, can: McpCaps): FooterAction[] {
  const footer: FooterAction[] = [{ key: "↑↓", action: "select" }]
  if (offeredActions(entry, can).length > 0) footer.push({ key: "→", action: "actions" })
  if (toggles(entry, can)) footer.push({ key: "space", action: "on/off" })
  if (reconnectsHere(entry, can)) footer.push({ key: "ctrl+r", action: "reconnect" })
  return [...footer, { key: "esc", action: "close" }]
}

export function McpTab(props: {
  api: TabApi
  // Null before the agent has listed them.
  servers: McpServerRow[] | null
  // The shared servers of a live session.
  shared?: SharedSession | null
  // Live only; without them each action shows a notice.
  actions?: Agent["mcp"]
  // The actions the agent has; the others are not offered.
  can: McpCaps
}) {
  const entries = createMemo(() => mcpEntries(props.servers, props.shared))
  const [opened, setOpened] = createSignal<string | null>(null)
  const entryFor = (row: DialogRow | undefined) => entries().find((entry) => entry.id === row?.id)

  const run = (entry: McpEntry, id: string) => {
    const actions = props.actions
    const { name } = entry.row
    if (!actions) return props.api.notify(SAVED_NOTICE)
    const done =
      id === "reconnect" || id === "restart"
        ? actions.reconnect(name)
        : id === "login"
          ? actions.login(name)
          : id === "on" || id === "off"
            ? actions.toggle(name, id === "on")
            : null
    void done?.then((outcome) => {
      if (!outcome.ok) props.api.notify(outcome.problem)
    })
  }

  return (
    <TwoPane
      api={props.api}
      sections={listSections(entries())}
      searchPlaceholder="Search servers"
      empty={(query) => {
        if (query) return `No servers match "${query}".`
        return props.servers ? "No MCP servers in this session." : "MCP servers appear after the first message."
      }}
      detail={(row, width) => {
        const entry = entryFor(row)
        return entry ? detailItems(entry, width, opened() === entry.id) : []
      }}
      actions={(row) => offeredActions(entryFor(row), props.can)}
      actionsNote={props.can.reach ?? undefined}
      onAction={(row, action) => {
        const entry = entryFor(row)
        if (!entry) return
        if (action.id === MORE_TOOLS) setOpened((id) => (id === entry.id ? null : entry.id))
        else run(entry, action.id)
      }}
      onKey={(key, row) => {
        const entry = entryFor(row)
        if (!entry) return false
        const { state } = entry.row
        if (key.name === "space" && toggles(entry, props.can)) run(entry, state === "off" ? "on" : "off")
        else if (key.ctrl && key.name === "r" && reconnectsHere(entry, props.can)) run(entry, "reconnect")
        else return false
        return true
      }}
      footer={(row) => listFooter(entryFor(row), props.can)}
    />
  )
}
