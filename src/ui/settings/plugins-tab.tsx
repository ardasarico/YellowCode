import type { Plugin } from "../../session/plugins.ts"
import { theme } from "../../theme/theme.ts"
import { createSignal } from "solid-js"
import { blank, fact, header, names, title } from "../dialog/detail.ts"
import type { DialogItem, DialogRow, DialogSection } from "../dialog/list.ts"
import type { FooterAction } from "../dialog/list-view.tsx"
import type { TabApi } from "../dialog/tabbed-dialog.tsx"
import { TwoPane } from "../dialog/two-pane.tsx"
import { REPLAY_NOTICE } from "../format.ts"

// The live connection runs this; without it each action shows the notice. It resolves with what changed where, and
// a rejection says what went wrong.
export type PluginActions = { setEnabled(plugin: Plugin, enabled: boolean): Promise<string> }

const LIST_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "→", action: "details" },
  { key: "space", action: "on/off" },
  { key: "esc", action: "close" },
]

const CATEGORIES: [keyof Plugin["brings"], string][] = [
  ["skills", "Skills"],
  ["mcp", "MCP servers"],
  ["commands", "Commands"],
  ["agents", "Agents"],
  ["hooks", "Hooks"],
]

const scopeLabel = (plugin: Plugin) => (plugin.scope === "project" ? "Project" : "Global")
const pluginId = (plugin: Plugin) => `${plugin.name}@${plugin.marketplace ?? ""}`

function listRow(plugin: Plugin): DialogRow {
  const row: DialogRow = {
    id: pluginId(plugin),
    label: plugin.name,
    tag: plugin.marketplace ?? undefined,
    search: `${plugin.name} ${plugin.marketplace ?? ""}`,
    value: scopeLabel(plugin),
  }
  if (plugin.on) return row
  return {
    ...row,
    marker: { text: "◯", fg: theme.panelFaint },
    labelColor: theme.panelFaint,
    valueColor: theme.panelFaint,
  }
}

const MORE = "-more"

function detailItems(plugin: Plugin, width: number, opened: Set<string>): DialogItem[] {
  const brings = CATEGORIES.flatMap(([key, label]) => {
    const list = plugin.brings[key]
    return list.length > 0 ? names(key, list, width, { label, open: opened.has(`${key}${MORE}`) }) : []
  })
  const state = plugin.on ? { text: "● on", fg: theme.success } : { text: "◯ off", fg: theme.panelFaint }
  return [
    header(plugin.name, state),
    blank("gap-head"),
    ...fact("scope", "Scope", scopeLabel(plugin), width),
    ...(plugin.marketplace ? fact("marketplace", "Marketplace", plugin.marketplace, width) : []),
    ...(brings.length > 0 ? [blank("gap-brings"), title("brings", "Brings"), ...brings] : []),
  ]
}

export function PluginsTab(props: { api: TabApi; plugins: Plugin[] | null; actions?: PluginActions }) {
  const sections = (): DialogSection[] => {
    const plugins = props.plugins ?? []
    return plugins.length > 0 ? [{ title: "", rows: plugins.map(listRow) }] : []
  }
  const pluginFor = (row: DialogRow) => props.plugins?.find((plugin) => pluginId(plugin) === row.id)
  // The lists opened past their first lines, for one plugin at a time.
  const [opened, setOpened] = createSignal<{ plugin: string; ids: Set<string> }>({ plugin: "", ids: new Set() })
  const openedFor = (row: DialogRow) => (opened().plugin === row.id ? opened().ids : new Set<string>())
  const toggle = (row: DialogRow, id: string) => {
    const ids = new Set(openedFor(row))
    if (!ids.delete(id)) ids.add(id)
    setOpened({ plugin: row.id, ids })
  }
  // The row changes once claude has reloaded its plugins.
  const turn = (row: DialogRow) => {
    const plugin = pluginFor(row)
    const actions = props.actions
    if (!actions) return props.api.notify(REPLAY_NOTICE)
    if (!plugin) return
    props.api.notify(`Turning ${plugin.on ? "off" : "on"} ${plugin.name}…`)
    actions.setEnabled(plugin, !plugin.on).then(
      (done) => props.api.notify(done),
      (error: unknown) => props.api.notify(error instanceof Error ? error.message : String(error)),
    )
  }

  return (
    <TwoPane
      api={props.api}
      sections={sections()}
      searchPlaceholder="Search plugins"
      empty={(query) => {
        if (query) return `No plugins match "${query}".`
        return props.plugins ? "No plugins in this session." : "Plugins appear after the first message."
      }}
      detail={(row, width) => {
        const plugin = pluginFor(row)
        return plugin ? detailItems(plugin, width, openedFor(row)) : []
      }}
      actions={(row) => [{ id: "toggle", label: pluginFor(row)?.on ? "Turn off" : "Turn on" }]}
      onAction={(row, action) => {
        if (action.id.endsWith(MORE)) toggle(row, action.id)
        else turn(row)
      }}
      onKey={(key, row) => {
        if (key.name !== "space" || !row) return false
        turn(row)
        return true
      }}
      footer={() => LIST_FOOTER}
    />
  )
}
