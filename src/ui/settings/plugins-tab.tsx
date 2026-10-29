import type { Agent } from "../../agent/agent.ts"
import type { PluginRow } from "../../agent/lists.ts"
import { theme } from "../../theme/theme.ts"
import { createSignal } from "solid-js"
import { blank, fact, header, names, title } from "../dialog/detail.ts"
import type { DialogItem, DialogRow, DialogSection } from "../dialog/list.ts"
import type { FooterAction } from "../dialog/list-view.tsx"
import type { TabApi } from "../dialog/tabbed-dialog.tsx"
import { TwoPane } from "../dialog/two-pane.tsx"
import { SAVED_NOTICE } from "../format.ts"

const LIST_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "→", action: "details" },
  { key: "space", action: "on/off" },
  { key: "esc", action: "close" },
]

const CATEGORIES: [keyof PluginRow["brings"], string][] = [
  ["skills", "Skills"],
  ["mcp", "MCP servers"],
  ["commands", "Commands"],
  ["agents", "Agents"],
  ["hooks", "Hooks"],
]

const scopeLabel = (plugin: PluginRow) => (plugin.scope === "project" ? "Project" : "Global")

function listRow(plugin: PluginRow): DialogRow {
  const row: DialogRow = {
    id: plugin.id,
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

function detailItems(plugin: PluginRow, width: number, opened: Set<string>, hooks: boolean): DialogItem[] {
  const brings = CATEGORIES.filter(([key]) => hooks || key !== "hooks").flatMap(([key, label]) => {
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

// Live only; without `actions` each action shows the notice. `toggles` and `hooks`: the agent turns plugins on and
// off, and lists their hooks.
export function PluginsTab(props: {
  api: TabApi
  plugins: PluginRow[] | null
  actions?: Agent["plugins"]
  toggles: boolean
  hooks: boolean
}) {
  const sections = (): DialogSection[] => {
    const plugins = props.plugins ?? []
    return plugins.length > 0 ? [{ title: "", rows: plugins.map(listRow) }] : []
  }
  const pluginFor = (row: DialogRow) => props.plugins?.find((plugin) => plugin.id === row.id)
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
    if (!actions) return props.api.notify(SAVED_NOTICE)
    if (!plugin) return
    props.api.notify(`Turning ${plugin.on ? "off" : "on"} ${plugin.name}…`)
    void actions
      .toggle(plugin.id, !plugin.on)
      .then((done) =>
        props.api.notify(done.ok ? (done.note ?? `${plugin.name} turned ${plugin.on ? "off" : "on"}`) : done.problem),
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
        return plugin ? detailItems(plugin, width, openedFor(row), props.hooks) : []
      }}
      actions={(row) => (props.toggles ? [{ id: "toggle", label: pluginFor(row)?.on ? "Turn off" : "Turn on" }] : [])}
      onAction={(row, action) => {
        if (action.id.endsWith(MORE)) toggle(row, action.id)
        else turn(row)
      }}
      onKey={(key, row) => {
        if (key.name !== "space" || !row || !props.toggles) return false
        turn(row)
        return true
      }}
      footer={() => (props.toggles ? LIST_FOOTER : LIST_FOOTER.filter((entry) => entry.key !== "space"))}
    />
  )
}
