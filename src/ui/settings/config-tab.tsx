import { isAbsolute } from "node:path"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import type { Outcome } from "../../agent/ids.ts"
import type { ModeRow } from "../../agent/lists.ts"
import type { SettingRow, SettingValue } from "../../agent/settings.ts"
import { tildePath } from "../../rewind/common.ts"
import { settings } from "../../session/settings.ts"
import { reloadThemes, theme } from "../../theme/theme.ts"
import { searchFooter, type TabApi } from "../dialog/tabbed-dialog.tsx"
import { type DialogSection, dialogLines, filterSections, moveSelection, selectableIds } from "../dialog/list.ts"
import { type FooterAction, ListView, PAD_X, printable } from "../dialog/list-view.tsx"
import { openFile } from "../dialog/open-file.ts"
import { SearchField } from "../dialog/search-field.tsx"
import {
  type AgentOption,
  currentOption,
  LONG,
  opensList,
  optionSections,
  preview,
  type SettingDefinition,
  settingsFor,
  step,
} from "./options.ts"

// The search row, its underline and the blank under it; a sub-list adds its breadcrumb and a blank.
const SEARCH_ROWS = 3
const CRUMB_ROWS = 2

const SELECT: FooterAction = { key: "↑↓", action: "select" }
const CHANGE: FooterAction = { key: "←→", action: "change" }
const OPEN: FooterAction = { key: "enter", action: "open" }
const RESET: FooterAction = { key: "ctrl+r", action: "reset" }
const CLOSE: FooterAction = { key: "esc", action: "close" }
const LIST_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "enter", action: "choose" },
  { key: "esc", action: "back" },
]

// The agent's own settings, null until they are read. `sent` holds the changes that went out while /settings is open,
// so a tab switch keeps showing them.
export type AgentSettings = {
  name: string
  rows: SettingRow[] | null
  sent: ReadonlyMap<string, SettingValue>
  busy: () => boolean
  change: (id: string, value: SettingValue) => Promise<Outcome>
}

const AGENT_PREFIX = "agent:"
// Each change may go to the agent as a command, so ←→ sends only where the presses stop.
const STEP_SEND_MS = 600
const choicesOf = (row: SettingRow) => (row.control.type === "choice" ? row.control.options : [])
const changeable = (row: SettingRow) => row.writable && choicesOf(row).length > 0
// The file a row's value comes from, when it is one the editor can open.
const fileOf = (row: SettingRow) => (row.origin && isAbsolute(row.origin.file) ? row.origin.file : null)
const remarkOf = (row: SettingRow) => {
  if (!row.writable) return "read-only"
  if (row.overriddenBy) return `set in ${row.overriddenBy}`
  return row.applies === "new-session" ? "new session" : undefined
}

const mainSections = (definitions: SettingDefinition[]): DialogSection[] =>
  [...new Set(definitions.map((setting) => setting.section))].map((section) => ({
    title: section,
    rows: definitions
      .filter((setting) => setting.section === section)
      .map((setting) => {
        const option = currentOption(setting)
        const value = opensList(setting) ? `${option?.label} →` : option?.label
        return { id: setting.key, label: setting.label, value, note: option?.note }
      }),
  }))

// `agent` is the agent whose YellowCode settings the tab shows, with its `modes`; `agents` the installed ones;
// `agentSettings` its own, on a live session.
export function ConfigTab(props: {
  api: TabApi
  agent: AgentOption
  modes: ModeRow[]
  agents: AgentOption[]
  agentSettings?: AgentSettings
  row?: string
}) {
  const definitions = createMemo(() => settingsFor(props.agent, props.modes, props.agents))
  const settingFor = (id: string) => definitions().find((setting) => setting.key === id)
  const [list, setList] = createSignal<SettingDefinition | null>(null)
  const [agentList, setAgentList] = createSignal<SettingRow | null>(null)
  const [query, setQuery] = createSignal("")
  const [chosen, setChosen] = createSignal<string | undefined>(untrack(() => props.row))
  const [stepped, setStepped] = createSignal<{ row: SettingRow; value: SettingValue } | null>(null)
  let stepTimer: ReturnType<typeof setTimeout> | undefined
  const agentFor = (id: string) =>
    id.startsWith(AGENT_PREFIX)
      ? props.agentSettings?.rows?.find((row) => row.id === id.slice(AGENT_PREFIX.length))
      : undefined
  const agentValue = (row: SettingRow) => {
    const pending = stepped()
    if (pending?.row.id === row.id) return pending.value
    return props.agentSettings?.sent.get(row.id) ?? row.value
  }
  // A choice not read yet shows "…"; any other row without a value has the agent's own default.
  const agentLabel = (row: SettingRow) => {
    const value = agentValue(row)
    const { control } = row
    if (control.type === "choice")
      return value === null ? "…" : (choicesOf(row).find((option) => option.value === value)?.label ?? String(value))
    if (value === null) return "default"
    if (value === "") return "none"
    if (control.type === "toggle") return value === true ? "on" : "off"
    return control.type === "number" && control.unit ? `${value} ${control.unit}` : String(value)
  }
  // Under the selected row: its own note, then the file its value comes from.
  const agentNote = (row: SettingRow) => {
    const file = fileOf(row)
    const where = file && `${tildePath(file)}${query() ? "" : " · e open in editor"}`
    return [row.note, where].filter(Boolean).join("\n") || undefined
  }
  const agentSections = (): DialogSection[] => {
    const rows = props.agentSettings?.rows ?? []
    return [...new Set(rows.map((row) => row.section))].map((section) => ({
      title: section || (props.agentSettings?.name ?? ""),
      rows: rows
        .filter((row) => row.section === section)
        .map((row) => ({
          id: `${AGENT_PREFIX}${row.id}`,
          label: row.label,
          value: changeable(row) && choicesOf(row).length > LONG ? `${agentLabel(row)} →` : agentLabel(row),
          tag: remarkOf(row),
          note: agentNote(row),
        })),
    }))
  }
  const agentOptions = (row: SettingRow): DialogSection[] => [
    {
      title: "",
      rows: choicesOf(row).map((option) => ({
        id: option.value,
        label: option.label,
        value: option.value === agentValue(row) ? "current" : undefined,
      })),
    },
  ]
  const changeAgent = (row: SettingRow, value: SettingValue) => {
    const agent = props.agentSettings
    if (!agent || value === agentValue(row)) return
    if (agent.busy()) return props.api.notify(`${agent.name} settings change once it is idle`)
    void agent.change(row.id, value).then((done) => {
      if (!done.ok) props.api.notify(done.problem)
    })
  }
  const sendStep = () => {
    clearTimeout(stepTimer)
    const pending = stepped()
    if (!pending) return
    setStepped(null)
    changeAgent(pending.row, pending.value)
  }
  const stepAgent = (row: SettingRow, by: 1 | -1) => {
    if (props.agentSettings?.busy())
      return props.api.notify(`${props.agentSettings.name} settings change once it is idle`)
    if (stepped()?.row.id !== row.id) sendStep()
    const options = choicesOf(row)
    const count = options.length
    const index = options.findIndex((option) => option.value === agentValue(row))
    const next = options[index === -1 ? (by === 1 ? 0 : count - 1) : (index + by + count) % count]
    if (!next) return
    setStepped({ row, value: next.value })
    clearTimeout(stepTimer)
    stepTimer = setTimeout(sendStep, STEP_SEND_MS)
  }
  onCleanup(sendStep)

  const sections = () => {
    const open = list()
    const openAgent = agentList()
    if (openAgent) return agentOptions(openAgent)
    return open ? optionSections(open, "") : [...mainSections(definitions()), ...agentSections()]
  }
  const visible = createMemo(() => filterSections(sections(), query()))
  const ids = createMemo(() => selectableIds(visible()))
  // An agent row asked for before the agent's rows are read stays chosen, and keys wait, until they come.
  const waiting = () => props.agentSettings?.rows === null && chosen()?.startsWith(AGENT_PREFIX) === true
  // No chosen row means the search row has the focus.
  const selectedId = () => {
    const id = chosen()
    if (id === undefined || waiting()) return id
    return ids().includes(id) ? id : ids()[0]
  }
  const search = (text: string) => {
    setQuery(text)
    setChosen(selectedId())
  }
  const shownId = () => (props.api.focused() ? selectedId() : undefined)
  const lines = createMemo(() => {
    const body = dialogLines(visible(), shownId())
    if (body.length > 0 || !query()) return body
    return [
      {
        kind: "text" as const,
        text: { id: "empty", spans: [{ text: `No settings match "${query()}".`, fg: theme.panelMuted }] },
      },
    ]
  })

  createEffect(
    on(selectedId, (id) => {
      if (list()?.key === "theme" && id) preview(id)
    }),
  )
  onCleanup(() => {
    if (list()?.key === "theme") preview(settings.theme)
  })

  const openList = (setting: SettingDefinition) =>
    batch(() => {
      if (setting.key === "theme") reloadThemes()
      setQuery("")
      setList(setting)
      setChosen(setting.value())
    })
  const back = (setting: SettingDefinition) =>
    batch(() => {
      if (setting.key === "theme") preview(settings.theme)
      setQuery("")
      setList(null)
      setChosen(setting.key)
    })

  const backAgent = (row: SettingRow) =>
    batch(() => {
      setQuery("")
      setAgentList(null)
      setChosen(`${AGENT_PREFIX}${row.id}`)
    })

  untrack(() => props.api).bind({
    footer: () => {
      const listing = list() ?? agentList()
      const id = selectedId()
      if (id === undefined) return searchFooter(listing ? "back" : "close")
      if (listing) return LIST_FOOTER
      if (waiting()) return [CLOSE]
      const agentRow = agentFor(id)
      if (agentRow) {
        const count = changeable(agentRow) ? choicesOf(agentRow).length : 0
        return [SELECT, ...(count > 0 ? [CHANGE] : []), ...(count > LONG ? [OPEN] : []), CLOSE]
      }
      const setting = settingFor(id)
      return [SELECT, CHANGE, ...(setting && opensList(setting) ? [OPEN] : []), RESET, CLOSE]
    },
    keys: (key) => {
      if (waiting()) return key.name !== "escape"
      const id = selectedId()
      const open = list()
      const openAgent = agentList()
      if (openAgent) {
        if (key.name === "up") setChosen(moveSelection(ids(), id, -1))
        else if (key.name === "down") setChosen(moveSelection(ids(), id, 1))
        else if (key.name === "return" && id) {
          changeAgent(openAgent, id)
          backAgent(openAgent)
        } else if (key.name === "escape") backAgent(openAgent)
        return true
      }
      const agentRow = id && !open ? agentFor(id) : undefined
      if (agentRow) {
        const file = fileOf(agentRow)
        if (file && key.name === "e" && !key.shift && printable(key) && !query()) {
          void openFile(file)
          return true
        }
        if (!changeable(agentRow)) {
          if (key.name === "left" || key.name === "right" || key.name === "return") return true
        } else if (key.name === "left" || key.name === "right") stepAgent(agentRow, key.name === "left" ? -1 : 1)
        else if (key.name === "return") {
          if (choicesOf(agentRow).length > LONG)
            batch(() => {
              sendStep()
              setQuery("")
              setAgentList(agentRow)
              const value = agentValue(agentRow)
              setChosen(value === null ? choicesOf(agentRow)[0]?.value : String(value))
            })
          else stepAgent(agentRow, 1)
          return true
        }
      }
      const setting = id && !open ? settingFor(id) : undefined
      if (key.name === "up") {
        if (id === undefined) props.api.toStrip()
        else setChosen(ids().indexOf(id) <= 0 ? undefined : moveSelection(ids(), id, -1))
      } else if (key.name === "down") setChosen(moveSelection(ids(), id, 1))
      else if ((key.name === "left" || key.name === "right") && setting) step(setting, key.name === "left" ? -1 : 1)
      else if (key.ctrl && key.name === "r") {
        if (setting) setting.reset()
      } else if (key.name === "return") {
        if (open && id) {
          open.set(id)
          back(open)
        } else if (setting && opensList(setting)) openList(setting)
        else if (setting) step(setting, 1)
      } else if (key.name === "escape") {
        if (query()) search("")
        else if (open) back(open)
        else return false
      } else if (key.name === "backspace") search(Array.from(query()).slice(0, -1).join(""))
      else if (printable(key)) search(query() + key.sequence)
      return true
    },
  })

  const listRows = () => Math.max(0, props.api.rows() - SEARCH_ROWS - (list() || agentList() ? CRUMB_ROWS : 0))

  return (
    <box flexDirection="column">
      <Show when={list() ?? agentList()}>
        {(open) => (
          <>
            <box height={1} paddingLeft={PAD_X}>
              <text wrapMode="none">
                <span style={{ fg: theme.panelMuted }}>Config</span>
                <span style={{ fg: theme.panelFaint }}>{" › "}</span>
                <span style={{ fg: theme.accent, bold: true }}>{open().label}</span>
              </text>
            </box>
            <box height={1} />
          </>
        )}
      </Show>
      <SearchField
        query={query()}
        placeholder="Search"
        focused={props.api.focused() && selectedId() === undefined}
        width={props.api.width()}
      />
      <box height={1} />
      <ListView
        sections={sections()}
        lines={lines()}
        selected={shownId()}
        view={list()?.key ?? agentList()?.id ?? "rows"}
        rows={listRows()}
        width={props.api.width()}
        inset
      />
    </box>
  )
}
