import { createMemo, createSignal } from "solid-js"
import type { McpConfig, McpServer } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { blank, fact, header, names, title } from "../dialog/detail.ts"
import type { DialogItem, DialogRow, DialogSection } from "../dialog/list.ts"
import type { FooterAction } from "../dialog/list-view.tsx"
import type { TabApi } from "../dialog/tabbed-dialog.tsx"
import { TwoPane } from "../dialog/two-pane.tsx"
import { REPLAY_NOTICE } from "../format.ts"
import type { Span } from "../notice.ts"
import { MCP_GROUPS, type McpEntry, type McpState, mcpEntries } from "./servers.ts"

// The live connection runs these; without them each action shows a notice. A rejection says what went wrong.
export type McpActions = {
  reconnect(name: string): Promise<void>
  setEnabled(name: string, enabled: boolean): Promise<void>
  login(name: string): Promise<void>
}

const MORE_TOOLS = "tools-more"

const look = (state: McpState) =>
  ({
    failed: { mark: "✕", word: "failed", color: theme.error },
    "needs-login": { mark: "!", word: "needs login", color: theme.warning },
    connecting: { mark: "◌", word: "connecting", color: theme.accent },
    connected: { mark: "", word: "connected", color: theme.text },
    off: { mark: "", word: "off", color: theme.panelFaint },
  })[state]

const toolCount = (count: number) => (count === 1 ? "1 tool" : `${count} tools`)
const reconnects = (state: McpState) => state !== "needs-login" && state !== "off"

function listRow(entry: McpEntry): DialogRow {
  const { mark, word, color } = look(entry.state)
  const row: DialogRow = {
    id: entry.server.name,
    label: entry.label,
    tag: entry.tag,
    search: `${entry.label} ${entry.tag}`,
    marker: mark ? { text: mark, fg: color } : undefined,
    labelColor: entry.state === "off" ? theme.panelFaint : undefined,
    valueColor: color,
  }
  if (entry.state === "connected") return { ...row, value: toolCount(entry.tools.length), valueColor: theme.panelFaint }
  if (entry.state === "needs-login") return { ...row, selectedValue: word }
  return { ...row, value: word }
}

const listSections = (entries: McpEntry[]): DialogSection[] =>
  MCP_GROUPS.map(([group, heading]) => ({
    title: heading,
    rows: entries.filter((entry) => entry.group === group).map(listRow),
  })).filter((section) => section.rows.length > 0)

function stateSpan(state: McpState): Span {
  const { mark, word, color } = look(state)
  if (state === "connected") return { text: `● ${word}`, fg: theme.success }
  if (state === "off") return { text: `◯ ${word}`, fg: theme.panelFaint }
  return { text: `${mark} ${word}`, fg: color }
}

function shownConfig(config: McpConfig): [string, string] {
  if ("command" in config) return ["Command", [config.command, config.package].filter(Boolean).join(" ")]
  return ["URL", config.url]
}

function detailItems(entry: McpEntry, width: number, open: boolean): DialogItem[] {
  const config = entry.server.config ? shownConfig(entry.server.config) : null
  const tools =
    entry.tools.length > 0
      ? [
          blank("gap-tools"),
          title("tools", `Tools · ${entry.tools.length}`),
          ...names("tools", entry.tools, width, { open }),
        ]
      : []
  return [
    header(entry.label, stateSpan(entry.state)),
    blank("gap-head"),
    ...(entry.where ? fact("scope", "Scope", entry.where, width) : []),
    ...(entry.server.error ? fact("error", "Error", entry.server.error, width, theme.error) : []),
    ...(config ? fact("config", config[0], config[1], width) : []),
    ...tools,
  ]
}

function stateActions(state: McpState): DialogRow[] {
  const off = { id: "off", label: "Turn off" }
  if (state === "needs-login") return [{ id: "login", label: "Log in" }, off]
  if (state === "off") return [{ id: "on", label: "Turn on" }]
  if (state === "connecting") return [off]
  if (state === "connected") return [{ id: "restart", label: "Restart" }, off]
  return [{ id: "reconnect", label: "Reconnect" }, off]
}

function listFooter(entry: McpEntry | undefined): FooterAction[] {
  const footer: FooterAction[] = [
    { key: "↑↓", action: "select" },
    { key: "→", action: "actions" },
  ]
  if (entry) footer.push({ key: "space", action: "on/off" })
  if (entry && reconnects(entry.state)) footer.push({ key: "ctrl+r", action: "reconnect" })
  return [...footer, { key: "esc", action: "close" }]
}

export function McpTab(props: {
  api: TabApi
  servers: McpServer[] | null
  // The session's tools, for servers without a tool list of their own.
  tools: string[]
  actions?: McpActions
}) {
  const entries = createMemo(() => mcpEntries(props.servers, props.tools))
  const [opened, setOpened] = createSignal<string | null>(null)
  const entryFor = (row: DialogRow | undefined) => entries().find((entry) => entry.server.name === row?.id)

  const run = (entry: McpEntry, id: string) => {
    const actions = props.actions
    const name = entry.server.name
    if (!actions) return props.api.notify(REPLAY_NOTICE)
    const done =
      id === "reconnect" || id === "restart"
        ? actions.reconnect(name)
        : id === "login"
          ? actions.login(name)
          : id === "on" || id === "off"
            ? actions.setEnabled(name, id === "on")
            : null
    done?.catch((error: unknown) => props.api.notify(error instanceof Error ? error.message : String(error)))
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
        return entry ? detailItems(entry, width, opened() === entry.server.name) : []
      }}
      actions={(row) => stateActions(entryFor(row)?.state ?? "off")}
      onAction={(row, action) => {
        const entry = entryFor(row)
        if (!entry) return
        if (action.id === MORE_TOOLS) setOpened((name) => (name === entry.server.name ? null : entry.server.name))
        else run(entry, action.id)
      }}
      onKey={(key, row) => {
        const entry = entryFor(row)
        if (!entry) return false
        if (key.name === "space") run(entry, entry.state === "off" ? "on" : "off")
        else if (key.ctrl && key.name === "r" && reconnects(entry.state)) run(entry, "reconnect")
        else return false
        return true
      }}
      footer={(row) => listFooter(entryFor(row))}
    />
  )
}
