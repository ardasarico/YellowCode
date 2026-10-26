import { batch, createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import { CLAUDE_SETTINGS, type ClaudeSetting } from "../../session/claude-settings.ts"
import { resetSetting, settings } from "../../session/settings.ts"
import { reloadThemes, theme } from "../../theme/theme.ts"
import { searchFooter, type TabApi } from "../dialog/tabbed-dialog.tsx"
import { type DialogSection, dialogLines, filterSections, moveSelection, selectableIds } from "../dialog/list.ts"
import { type FooterAction, ListView, PAD_X, printable } from "../dialog/list-view.tsx"
import { SearchField } from "../dialog/search-field.tsx"
import {
  choose,
  currentOption,
  LONG,
  opensList,
  optionSections,
  preview,
  SETTINGS,
  type SettingDefinition,
  settingFor,
  step,
} from "./options.ts"

const SECTIONS = [...new Set(SETTINGS.map((setting) => setting.section))]
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

// Claude Code's own settings: what get_settings read, and the change that goes out as claude's own command.
// `sent` holds the changes that went out while /settings is open, so a tab switch keeps showing them.
export type ClaudeSettings = {
  effective: Record<string, unknown> | null
  model: string | null
  sent: ReadonlyMap<string, string>
  busy: () => boolean
  // False when the message could not go out.
  change: (id: string, value: string, command: string) => boolean
}

const CLAUDE_PREFIX = "claude:"
const claudeFor = (id: string) =>
  id.startsWith(CLAUDE_PREFIX)
    ? CLAUDE_SETTINGS.find((setting) => setting.id === id.slice(CLAUDE_PREFIX.length))
    : undefined

const mainSections = (): DialogSection[] =>
  SECTIONS.map((section) => ({
    title: section,
    rows: SETTINGS.filter((setting) => setting.section === section).map((setting) => {
      const option = currentOption(setting)
      const value = opensList(setting) ? `${option?.label} →` : option?.label
      return { id: setting.key, label: setting.label, value, note: option?.note }
    }),
  }))

export function ConfigTab(props: { api: TabApi; claude?: ClaudeSettings; row?: string }) {
  const [list, setList] = createSignal<SettingDefinition | null>(null)
  const [claudeList, setClaudeList] = createSignal<ClaudeSetting | null>(null)
  const [query, setQuery] = createSignal("")
  const [chosen, setChosen] = createSignal<string | undefined>(untrack(() => props.row))
  const claudeValue = (setting: ClaudeSetting) => {
    const claude = props.claude
    return claude?.sent.get(setting.id) ?? (claude?.effective ? setting.read(claude.effective, claude.model) : null)
  }
  const claudeLabel = (setting: ClaudeSetting) => {
    if (!props.claude?.effective && !props.claude?.sent.has(setting.id)) return "…"
    const value = claudeValue(setting)
    if (value === null) return "default"
    return setting.options.find((option) => option.value === value)?.label ?? value
  }
  const claudeSection = (): DialogSection[] =>
    props.claude
      ? [
          {
            title: "Claude Code",
            rows: CLAUDE_SETTINGS.map((setting) => ({
              id: `${CLAUDE_PREFIX}${setting.id}`,
              label: setting.label,
              value: setting.options.length > LONG ? `${claudeLabel(setting)} →` : claudeLabel(setting),
            })),
          },
        ]
      : []
  const claudeOptions = (setting: ClaudeSetting): DialogSection[] => [
    {
      title: "",
      rows: setting.options.map((option) => ({
        id: option.value,
        label: option.label,
        value: option.value === claudeValue(setting) ? "current" : undefined,
      })),
    },
  ]
  const changeClaude = (setting: ClaudeSetting, value: string) => {
    const claude = props.claude
    if (!claude || value === claudeValue(setting)) return
    if (claude.busy()) return props.api.notify("Claude Code settings change once it is idle")
    if (!claude.change(setting.id, value, setting.command(value))) props.api.notify("Claude Code did not take it")
  }
  const stepClaude = (setting: ClaudeSetting, by: 1 | -1) => {
    const count = setting.options.length
    const index = setting.options.findIndex((option) => option.value === claudeValue(setting))
    const next = setting.options[index === -1 ? (by === 1 ? 0 : count - 1) : (index + by + count) % count]
    if (next) changeClaude(setting, next.value)
  }

  const sections = () => {
    const open = list()
    const openClaude = claudeList()
    if (openClaude) return claudeOptions(openClaude)
    return open ? optionSections(open, "") : [...mainSections(), ...claudeSection()]
  }
  const visible = createMemo(() => filterSections(sections(), query()))
  const ids = createMemo(() => selectableIds(visible()))
  // No chosen row means the search row has the focus.
  const selectedId = () => {
    const id = chosen()
    if (id === undefined) return undefined
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
      setChosen(settings[setting.key])
    })
  const back = (setting: SettingDefinition) =>
    batch(() => {
      if (setting.key === "theme") preview(settings.theme)
      setQuery("")
      setList(null)
      setChosen(setting.key)
    })

  const backClaude = (setting: ClaudeSetting) =>
    batch(() => {
      setQuery("")
      setClaudeList(null)
      setChosen(`${CLAUDE_PREFIX}${setting.id}`)
    })

  untrack(() => props.api).bind({
    footer: () => {
      const listing = list() ?? claudeList()
      const id = selectedId()
      if (id === undefined) return searchFooter(listing ? "back" : "close")
      if (listing) return LIST_FOOTER
      const claude = claudeFor(id)
      if (claude) return [SELECT, ...(claude.options.length > LONG ? [OPEN] : [CHANGE]), CLOSE]
      const setting = settingFor(id)
      return [SELECT, CHANGE, ...(setting && opensList(setting) ? [OPEN] : []), RESET, CLOSE]
    },
    keys: (key) => {
      const id = selectedId()
      const open = list()
      const openClaude = claudeList()
      if (openClaude) {
        if (key.name === "up") setChosen(moveSelection(ids(), id, -1))
        else if (key.name === "down") setChosen(moveSelection(ids(), id, 1))
        else if (key.name === "return" && id) {
          changeClaude(openClaude, id)
          backClaude(openClaude)
        } else if (key.name === "escape") backClaude(openClaude)
        return true
      }
      const claude = id && !open ? claudeFor(id) : undefined
      if (claude) {
        if ((key.name === "left" || key.name === "right") && claude.options.length <= LONG)
          stepClaude(claude, key.name === "left" ? -1 : 1)
        else if (key.name === "return") {
          if (claude.options.length > LONG)
            batch(() => {
              setQuery("")
              setClaudeList(claude)
              setChosen(claudeValue(claude) ?? claude.options[0]?.value)
            })
          else stepClaude(claude, 1)
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
        if (setting) resetSetting(setting.key)
      } else if (key.name === "return") {
        if (open && id) {
          choose(open, id)
          back(open)
        } else if (setting && opensList(setting)) openList(setting)
      } else if (key.name === "escape") {
        if (query()) search("")
        else if (open) back(open)
        else return false
      } else if (key.name === "backspace") search(Array.from(query()).slice(0, -1).join(""))
      else if (printable(key)) search(query() + key.sequence)
      return true
    },
  })

  const listRows = () => Math.max(0, props.api.rows() - SEARCH_ROWS - (list() || claudeList() ? CRUMB_ROWS : 0))

  return (
    <box flexDirection="column">
      <Show when={list() ?? claudeList()}>
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
        view={list()?.key ?? claudeList()?.id ?? "rows"}
        rows={listRows()}
        width={props.api.width()}
        inset
      />
    </box>
  )
}
