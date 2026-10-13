import { batch, createMemo, createSignal } from "solid-js"
import type { McpConfig, SessionInfo } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog, type FooterAction } from "../dialog/dialog.tsx"
import type { DialogItem, DialogRow, DialogSection, DialogText } from "../dialog/list.ts"
import { wrapLines } from "../format.ts"
import type { Span } from "../notice.ts"
import { MCP_GROUPS, type McpEntry, type McpState, mcpEntries } from "./servers.ts"

// The live connection runs these; without them the dialog only shows what init reported.
export type McpActions = {
  reconnect(name: string): void
  setEnabled(name: string, enabled: boolean): void
  login(name: string): void
}

const MIN_HEIGHT = 14
const INNER = 56
const KEY_WIDTH = 9
const DETAILS_INDENT = 2

const look = (state: McpState) =>
  ({
    failed: { mark: "✕", word: "failed", color: theme.error },
    "needs-login": { mark: "!", word: "needs login", color: theme.warning },
    connecting: { mark: "◌", word: "connecting", color: theme.accent },
    connected: { mark: "", word: "connected", color: theme.text },
    off: { mark: "", word: "off", color: theme.faint },
  })[state]

const toolCount = (count: number) => (count === 1 ? "1 tool" : `${count} tools`)

function listRow(entry: McpEntry): DialogRow {
  const { mark, word, color } = look(entry.state)
  const row: DialogRow = {
    id: entry.server.name,
    label: entry.label,
    tag: entry.tag,
    search: `${entry.label} ${entry.tag}`,
    marker: mark ? { text: mark, fg: color } : undefined,
    labelColor: entry.state === "off" ? theme.faint : undefined,
    valueColor: color,
  }
  if (entry.state === "connected") return { ...row, value: toolCount(entry.tools.length), valueColor: theme.faint }
  if (entry.state === "needs-login") return { ...row, selectedValue: word }
  return { ...row, value: word }
}

const listSections = (entries: McpEntry[]): DialogSection[] =>
  MCP_GROUPS.map(([group, title]) => ({
    title,
    rows: entries.filter((entry) => entry.group === group).map(listRow),
  })).filter((section) => section.rows.length > 0)

const text = (id: string, spans: Span[], indent = 0): DialogText => ({ id, spans, indent })

function statusLine(entry: McpEntry): Span[] {
  const { mark, word, color } = look(entry.state)
  const where = entry.where ? [{ text: ` · ${entry.where}`, fg: theme.muted }] : []
  return [{ text: mark ? `${mark} ${word}` : word, fg: color }, ...where]
}

function shownConfig(config: McpConfig): [string, string] {
  if ("command" in config) return ["Command", [config.command, config.package].filter(Boolean).join(" ")]
  const url = URL.parse(config.url)
  return ["URL", url ? `${url.origin}${url.pathname}` : config.url]
}

function details(entry: McpEntry, indent: number): DialogText[] {
  const fields: [string, string, boolean][] = []
  if (entry.server.config) fields.push([...shownConfig(entry.server.config), false])
  const info = entry.server.serverInfo
  if (info) fields.push(["Server", `${info.name} ${info.version}`, false])
  fields.push(["Tools", entry.tools.length > 0 ? entry.tools.join(", ") : "none", entry.tools.length === 0])
  return fields.flatMap(([key, value, faint]) =>
    wrapLines(value, INNER - indent - KEY_WIDTH, 3).map((part, index) =>
      text(
        `${key}-${index}`,
        [
          { text: (index === 0 ? key : "").padEnd(KEY_WIDTH), fg: theme.muted },
          { text: part, fg: faint ? theme.faint : theme.text },
        ],
        indent,
      ),
    ),
  )
}

function fixes(state: McpState): DialogRow[] {
  if (state === "needs-login")
    return [
      { id: "login", label: "Log in" },
      { id: "off", label: "Turn off" },
    ]
  if (state === "off") return [{ id: "on", label: "Turn on" }]
  return [
    { id: "reconnect", label: "Reconnect" },
    { id: "off", label: "Turn off" },
  ]
}

function pageItems(entry: McpEntry, live: boolean, open: boolean): DialogItem[] {
  const error =
    entry.state === "failed" && entry.server.error
      ? wrapLines(entry.server.error, INNER, 3).map((line, index) =>
          text(`error-${index}`, [{ text: line, fg: theme.error }]),
        )
      : []
  const head = [text("status", statusLine(entry)), ...error, text("gap-head", [])]
  if (!live)
    return [
      ...head,
      ...details(entry, 0),
      text("gap-note", []),
      text("note", [{ text: "Actions need the live connection.", fg: theme.faint }]),
    ]
  return [
    ...head,
    ...fixes(entry.state),
    text("gap-details", []),
    { id: "details", label: `${open ? "▾" : "▸"} Details`, labelColor: theme.muted },
    ...(open ? details(entry, DETAILS_INDENT) : []),
  ]
}

export function McpDialog(props: { info: SessionInfo | null; actions?: McpActions; onClose: () => void }) {
  const entries = createMemo(() => mcpEntries(props.info))
  const [opened, setOpened] = createSignal<string | null>(null)
  const [returnTo, setReturnTo] = createSignal<string>()
  const [open, setOpen] = createSignal(false)
  const page = () => entries().find((entry) => entry.server.name === opened())

  const listFooter = (row: DialogRow | undefined): FooterAction[] => {
    const entry = entries().find((candidate) => candidate.server.name === row?.id)
    const footer: FooterAction[] = [{ action: "Open", key: "enter", needsRow: true }]
    if (!props.actions || !entry) return footer
    if (entry.state !== "needs-login" && entry.state !== "off") footer.push({ action: "Reconnect", key: "ctrl+r" })
    footer.push({ action: entry.state === "off" ? "Turn on" : "Turn off", key: "space" })
    return footer
  }

  const pageFooter = (): FooterAction[] =>
    props.actions
      ? [
          { action: "Choose", key: "enter" },
          { action: "Back", key: "esc" },
        ]
      : [{ action: "Back", key: "esc" }]

  const sections = (): DialogSection[] => {
    const entry = page()
    if (!entry) return listSections(entries())
    return [{ title: "", rows: pageItems(entry, Boolean(props.actions), open()) }]
  }

  const run = (entry: McpEntry, id: string) => {
    const actions = props.actions
    if (!actions) return
    const name = entry.server.name
    if (id === "reconnect") actions.reconnect(name)
    else if (id === "login") actions.login(name)
    else if (id === "on" || id === "off") actions.setEnabled(name, id === "on")
  }

  return (
    <Dialog
      title={page() ? `MCP / ${page()?.label}` : "MCP"}
      sections={sections()}
      footer={page() ? pageFooter() : listFooter}
      view={opened() ?? "list"}
      initialSelected={page() ? undefined : returnTo()}
      search={!page()}
      minHeight={MIN_HEIGHT}
      onEnter={(row) => {
        const entry = page()
        if (!entry)
          return batch(() => {
            setReturnTo(row.id)
            setOpen(false)
            setOpened(row.id)
          })
        if (row.id === "details") setOpen((value) => !value)
        else run(entry, row.id)
      }}
      onKey={(key, row) => {
        const entry = entries().find((candidate) => candidate.server.name === row?.id)
        if (page() || !entry || !props.actions) return false
        if (key.name === "space") run(entry, entry.state === "off" ? "on" : "off")
        else if (key.ctrl && key.name === "r" && entry.state !== "needs-login" && entry.state !== "off")
          run(entry, "reconnect")
        else return false
        return true
      }}
      onEscape={() => (page() ? setOpened(null) : props.onClose())}
      empty={(query) => {
        if (query) return `No servers match "${query}".`
        return props.info ? "No MCP servers in this session." : "MCP servers appear after the first message."
      }}
    />
  )
}
