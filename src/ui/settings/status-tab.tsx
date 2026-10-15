import { createMemo, createSignal, untrack } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { type DialogItem, dialogLines, moveSelection, selectableIds } from "../dialog/list.ts"
import { type FooterAction, ListView } from "../dialog/list-view.tsx"
import type { TabApi } from "../dialog/tabbed-dialog.tsx"
import type { SettingsTab } from "./settings-dialog.tsx"

export type StatusFacts = {
  version: string
  claudeVersion: string | null
  title: string | null
  sessionId: string | null
  model: string | null
  effort: string | null
  permissionMode: string | null
  mcpServers: number | null
  plugins: number | null
  skills: number | null
  tools: number | null
  sources: string[]
}

const COLUMN = "Permission mode".length + 3
const FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "enter", action: "open" },
  { key: "esc", action: "close" },
]

const shown = (value: string | number | null) =>
  value === null || value === "" ? { text: "–", fg: theme.panelMuted } : { text: String(value), fg: theme.text }

const fact = (label: string, value: string | number | null): DialogItem => ({
  id: label,
  spans: [{ text: label.padEnd(COLUMN), fg: theme.panelMuted }, shown(value)],
})

const blank = (id: string): DialogItem => ({ id, spans: [] })

const jump = (id: "mcp" | "plugins", label: string, count: number | null): DialogItem => ({
  id,
  label,
  detail: `${shown(count).text} ›`,
  labelColor: theme.panelMuted,
  valueColor: count === null ? theme.panelMuted : theme.text,
})

export function StatusTab(props: { api: TabApi<SettingsTab>; facts: StatusFacts }) {
  const [chosen, setChosen] = createSignal<string>()
  const sections = createMemo(() => {
    const facts = props.facts
    return [
      {
        title: "",
        rows: [
          fact("YellowCode", facts.version),
          fact("Claude Code", facts.claudeVersion),
          blank("gap-versions"),
          fact("Session", facts.title),
          fact("Session ID", facts.sessionId),
          blank("gap-session"),
          fact("Model", facts.model),
          fact("Effort", facts.effort),
          fact("Permission mode", facts.permissionMode),
          blank("gap-model"),
          jump("mcp", "MCP servers", facts.mcpServers),
          jump("plugins", "Plugins", facts.plugins),
          fact("Skills", facts.skills),
          fact("Tools", facts.tools),
          blank("gap-counts"),
          fact("Setting sources", facts.sources.join(", ")),
        ],
      },
    ]
  })
  const ids = createMemo(() => selectableIds(sections()))
  const selectedId = () => {
    const id = chosen()
    return id !== undefined && ids().includes(id) ? id : ids()[0]
  }
  const shownId = () => (props.api.focused() ? selectedId() : undefined)

  untrack(() => props.api).bind({
    footer: () => FOOTER,
    keys: (key) => {
      const id = selectedId()
      if (key.name === "up") {
        if (ids().indexOf(id ?? "") <= 0) props.api.toStrip()
        else setChosen(moveSelection(ids(), id, -1))
      } else if (key.name === "down") setChosen(moveSelection(ids(), id, 1))
      else if (key.name === "return") {
        if (id === "mcp" || id === "plugins") props.api.open(id)
      } else return key.name !== "escape"
      return true
    },
  })

  return (
    <box flexDirection="column">
      <ListView
        sections={sections()}
        lines={dialogLines(sections(), shownId())}
        selected={shownId()}
        view="status"
        rows={props.api.rows()}
        width={props.api.width()}
        detailColumn={COLUMN}
        inset
      />
    </box>
  )
}
