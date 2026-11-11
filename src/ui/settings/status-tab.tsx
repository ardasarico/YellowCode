import { createMemo, createSignal, untrack } from "solid-js"
import { configPath } from "../../config-path.ts"
import { tildePath } from "../../rewind/common.ts"
import { theme } from "../../theme/theme.ts"
import { type DialogItem, type DialogLine, dialogLines, moveSelection, selectableIds } from "../dialog/list.ts"
import { type FooterAction, ListView } from "../dialog/list-view.tsx"
import { openFile } from "../dialog/open-file.ts"
import type { TabApi } from "../dialog/tabbed-dialog.tsx"
import type { SettingsTab } from "./settings-dialog.tsx"

// The lists with a dialog of their own; the id is the dialog's name.
export type StatusList = "mcp" | "skills" | "agents" | "permissions"
// Null while the provider has not listed them yet.
export type ListFact = { count: number | null; problem?: string }

// The Status tab's rows to those dialogs, in this order. A list without a fact has no row.
const LISTS: { id: StatusList; label: string; about: string }[] = [
  { id: "mcp", label: "MCP servers", about: "Outside tools and data the agent can reach." },
  { id: "skills", label: "Skills", about: "Instructions the agent loads when a task needs them." },
  { id: "agents", label: "Subagents", about: "Helpers the agent hands work to, each on the model you pick." },
  { id: "permissions", label: "Permissions", about: "What you allowed for good, so the agent does not ask again." },
]

export type StatusFacts = {
  version: string
  agent: string
  agentVersion: string | null
  title: string | null
  sessionId: string | null
  model: string | null
  effort: string | null
  permissionMode: string | null
  // undefined when the agent has no such list at all.
  plugins: number | null | undefined
  // A list the provider does not fill is left out.
  lists: Partial<Record<StatusList, ListFact>>
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

const settingsFile = (): DialogItem => ({
  id: "settings-file",
  label: "Settings file",
  detail: tildePath(configPath("settings.json")),
  selectedValue: "enter open",
  labelColor: theme.panelMuted,
  valueColor: theme.text,
})

const jump = (id: "plugins", label: string, count: number | null): DialogItem => ({
  id,
  label,
  detail: `${shown(count).text} ›`,
  labelColor: theme.panelMuted,
  valueColor: count === null ? theme.panelMuted : theme.text,
})

const listRows = (facts: StatusFacts): DialogItem[] =>
  LISTS.flatMap(({ id, label }) => {
    const list = facts.lists[id]
    if (!list) return []
    return {
      id,
      label,
      detail: [shown(list.count).text, list.problem].filter(Boolean).join(" · "),
      value: "›",
      valueColor: list.count === null ? theme.panelMuted : theme.text,
    }
  })

// Each list row's sentence goes under it as a note, which scrolls into view with its row.
const withAbout = (lines: DialogLine[]): DialogLine[] =>
  lines.flatMap((line) => {
    const about = line.kind === "row" ? LISTS.find((list) => list.id === line.row.id)?.about : undefined
    return about ? [line, { kind: "note", text: about }] : [line]
  })

const isList = (id: string | undefined): id is StatusList => LISTS.some((list) => list.id === id)

export function StatusTab(props: {
  api: TabApi<SettingsTab>
  facts: StatusFacts
  // The row it opens on.
  row?: string
  onOpen: (list: StatusList) => void
}) {
  const [chosen, setChosen] = createSignal(untrack(() => props.row))
  const sections = createMemo(() => {
    const facts = props.facts
    return [
      {
        title: "",
        rows: [
          fact("YellowCode", facts.version),
          fact(facts.agent, facts.agentVersion),
          blank("gap-versions"),
          fact("Session", facts.title),
          fact("Session ID", facts.sessionId),
          blank("gap-session"),
          fact("Model", facts.model),
          fact("Effort", facts.effort),
          fact("Permission mode", facts.permissionMode),
          blank("gap-model"),
          ...(facts.plugins === undefined ? [] : [jump("plugins", "Plugins", facts.plugins)]),
          fact("Tools", facts.tools),
          fact("Setting sources", facts.sources.join(", ")),
          blank("gap-sources"),
          settingsFile(),
          blank("gap-lists"),
          ...listRows(facts),
        ],
      },
    ]
  })
  const ids = createMemo(() => selectableIds(sections()))
  const selectedId = () => {
    const id = chosen()
    return id !== undefined && ids().includes(id) ? id : (ids().find(isList) ?? ids()[0])
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
        if (isList(id)) props.onOpen(id)
        if (id === "plugins") props.api.open(id)
        if (id === "settings-file") void openFile(configPath("settings.json"))
      } else return key.name !== "escape"
      return true
    },
  })

  return (
    <box flexDirection="column">
      <ListView
        sections={sections()}
        lines={withAbout(dialogLines(sections(), shownId()))}
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
