import type { KeyEvent } from "@opentui/core"
import { createSignal } from "solid-js"
import type { ModSettingDefinition, ModSettingValue } from "../../mods/api.ts"
import type { ModEntry, ModHost, ModStatus } from "../../mods/host.ts"
import { keyText } from "../../mods/keys.ts"
import { counts, modPanes } from "../../mods/registry.ts"
import { serverErrors } from "../../source/mod-tools.ts"
import type { SettingsHandle } from "../../mods/settings.ts"
import { tildePath } from "../../rewind/common.ts"
import { theme } from "../../theme/theme.ts"
import { blank, fact, header, text, title } from "../dialog/detail.ts"
import type { DialogItem, DialogRow, DialogSection } from "../dialog/list.ts"
import type { FooterAction } from "../dialog/list-view.tsx"
import { openFolder } from "../dialog/open-file.ts"
import type { TabApi } from "../dialog/tabbed-dialog.tsx"
import { TwoPane } from "../dialog/two-pane.tsx"
import { printable } from "../dialog/list-view.tsx"
import { crowded } from "../mod-pane.tsx"
import { cut } from "../format.ts"
import type { Span } from "../notice.ts"

const STACK_LINES = 8
const SETTING = "setting:"

// A text setting being typed: its key and the text so far.
// `capture` waits for the next key press, for a key setting.
type Editing = { key: string; draft: string; capture?: boolean }

const settingKey = (item: DialogRow | undefined) =>
  item?.id.startsWith(SETTING) ? item.id.slice(SETTING.length) : null

const look = (status: ModStatus) =>
  ({
    on: { mark: "●", color: theme.success },
    off: { mark: "◯", color: theme.panelFaint },
    failed: { mark: "✕", color: theme.error },
    incompatible: { mark: "!", color: theme.warning },
  })[status]

const nameOf = (entry: ModEntry) => entry.manifest?.name ?? entry.id

function listRow(entry: ModEntry): DialogRow {
  const { mark, color } = look(entry.status)
  return {
    id: entry.id,
    label: nameOf(entry),
    search: `${entry.id} ${nameOf(entry)} ${entry.manifest?.description ?? ""}`,
    marker: { text: mark, fg: color },
    labelColor: entry.status === "on" ? undefined : entry.status === "off" ? theme.panelFaint : color,
    value: entry.manifest?.version,
    valueColor: theme.panelFaint,
  }
}

function statusSpan(entry: ModEntry): Span {
  const { mark, color } = look(entry.status)
  const word =
    entry.status === "failed"
      ? !entry.error
        ? "failed"
        : // A mod that loaded keeps its load time when it fails later.
          entry.loadMs === null
          ? "failed at setup"
          : "failed while running"
      : entry.status === "incompatible"
        ? (entry.problem ?? "incompatible")
        : entry.status
  return { text: `${mark} ${word}`, fg: color }
}

function errorLines(entry: ModEntry, width: number): DialogItem[] {
  const error = entry.error
  if (!error)
    return entry.problem && entry.status === "failed"
      ? fact("problem", "Problem", entry.problem, width, theme.error)
      : []
  // Only the mod's own frames, with paths relative to its folder and without the reload query.
  const stack = (error.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") && line.includes(entry.folder))
    .map((line) => line.replaceAll(`${entry.folder}/`, "").replace(/\?v=\d+/g, ""))
    .slice(0, STACK_LINES)
  return [
    blank("gap-error"),
    title("error", "Last error"),
    text("error-message", [{ text: cut(error.message, width), fg: theme.error }]),
    ...stack.map((line, index) =>
      text(`error-stack-${index}`, [{ text: cut(`  ${line}`, width), fg: theme.panelMuted }]),
    ),
  ]
}

function shownValue(definition: ModSettingDefinition, value: ModSettingValue): string {
  if (definition.type === "choice")
    return `‹ ${definition.options.find((option) => option.id === value)?.label ?? String(value)} ›`
  if (definition.type === "boolean") return value ? "on" : "off"
  if (definition.type === "number") return `${String(value)}${definition.unit ? ` ${definition.unit}` : ""}`
  return String(value)
}

function settingItems(settings: SettingsHandle | null, editing: Editing | null, width: number): DialogItem[] {
  const entries = Object.entries(settings?.definitions ?? {})
  if (!settings || entries.length === 0) return []
  return [
    blank("gap-settings"),
    text("rule", [{ text: "─".repeat(width), fg: theme.frame }]),
    title("settings", "Settings"),
    ...entries.map(([key, definition]): DialogRow => {
      const typing = editing?.key === key
      return {
        id: `${SETTING}${key}`,
        label: definition.label,
        value: typing
          ? editing.capture
            ? "press a key"
            : `${editing.draft}▏`
          : shownValue(definition, settings.get(key)),
        note: definition.type === "number" ? undefined : definition.note,
        valueColor: typing ? theme.accent : undefined,
      }
    }),
  ]
}

function detailItems(entry: ModEntry, width: number, settings: SettingsHandle | null, editing: Editing | null) {
  const manifest = entry.manifest
  const heading = manifest ? `${manifest.name} ${manifest.version}` : entry.id
  const description = manifest?.description
    ? [text("description", [{ text: manifest.description, fg: theme.text }])]
    : []
  const adds = counts(entry.id)
  return [
    header(heading, statusSpan(entry)),
    ...description,
    ...fact("source", "Source", tildePath(entry.folder), width),
    ...fact("adds", "Adds", adds.length > 0 ? adds.join(" · ") : "nothing", width),
    ...fact("load", "Load time", entry.loadMs === null ? "—" : `${entry.loadMs} ms`, width),
    ...Object.entries(serverErrors())
      .filter(([server]) => server === `mod-${entry.id}` || server.startsWith(`mod-${entry.id}--`))
      .flatMap(([server, error]) => fact(`mcp-${server}`, "MCP", `${server}: ${error}`, width, theme.error)),
    ...(modPanes().some((pane) => pane.mod === entry.id && crowded().has(pane.key))
      ? fact("room", "Pane", "no room in this window", width, theme.warning)
      : []),
    ...errorLines(entry, width),
    ...settingItems(settings, editing, width),
  ]
}

function actions(entry: ModEntry): DialogRow[] {
  const folder = { id: "folder", label: "Open folder" }
  const reload = { id: "reload", label: "Reload" }
  if (entry.status === "off") return [{ id: "on", label: "Turn on" }, folder]
  if (entry.status === "incompatible") return [reload, folder]
  return [{ id: "off", label: "Turn off" }, reload, folder]
}

const SETTING_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "←→", action: "change" },
  { key: "esc", action: "back" },
]
const TEXT_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "enter", action: "edit" },
  { key: "esc", action: "back" },
]
const CAPTURE_FOOTER: FooterAction[] = [
  { key: "a key", action: "set" },
  { key: "esc", action: "cancel" },
]
const TYPING_FOOTER: FooterAction[] = [
  { key: "enter", action: "save" },
  { key: "esc", action: "cancel" },
]

// ←→ and space change a choice, a switch or a number in place; a text setting is typed after Enter.
function changeSetting(settings: SettingsHandle, key: string, step: 1 | -1): void {
  const definition = settings.definitions[key]
  const value = settings.get(key)
  if (definition?.type === "choice") {
    const index = definition.options.findIndex((option) => option.id === value)
    const next = definition.options[(index + step + definition.options.length) % definition.options.length]
    if (next !== undefined) settings.set(key, next.id)
  } else if (definition?.type === "boolean") settings.set(key, !value)
  else if (definition?.type === "number")
    settings.set(key, Math.min(definition.max, Math.max(definition.min, Number(value) + step * definition.step)))
}

const FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "space", action: "on/off" },
  { key: "r", action: "reload" },
  { key: "enter", action: "open folder" },
  { key: "esc", action: "close" },
]

export function ModsTab(props: { api: TabApi; host: ModHost }) {
  const [editing, setEditing] = createSignal<Editing | null>(null)

  const detailKey = (key: KeyEvent, row: DialogRow, focused: DialogRow | undefined): boolean => {
    const settings = props.host.settings(row.id)
    const name = settingKey(focused)
    const typing = editing()
    if (typing?.capture) {
      if (key.name !== "escape") settings?.set(typing.key, keyText(key))
      setEditing(null)
      return true
    }
    if (typing) {
      if (key.name === "return") {
        settings?.set(typing.key, typing.draft)
        setEditing(null)
      } else if (key.name === "escape") setEditing(null)
      else if (key.name === "backspace")
        setEditing({ ...typing, draft: Array.from(typing.draft).slice(0, -1).join("") })
      else if (printable(key)) setEditing({ ...typing, draft: typing.draft + key.sequence })
      return true
    }
    if (!settings || name === null) return false
    const definition = settings.definitions[name]
    if (definition?.type === "text" || definition?.type === "key") {
      if (key.name !== "return") return false
      setEditing({ key: name, draft: String(settings.get(name)), capture: definition.type === "key" })
      return true
    }
    if (key.name === "left" || key.name === "right") changeSetting(settings, name, key.name === "left" ? -1 : 1)
    else if (key.name === "space" && definition?.type === "boolean") changeSetting(settings, name, 1)
    else return false
    return true
  }

  const entryFor = (row: DialogRow | undefined) => props.host.entries.find((entry) => entry.id === row?.id)
  const sections = (): DialogSection[] => [
    { title: "", rows: props.host.entries.toSorted((a, b) => nameOf(a).localeCompare(nameOf(b))).map(listRow) },
  ]

  const run = (entry: ModEntry, id: string) => {
    const done =
      id === "on" || id === "off"
        ? props.host.setEnabled(entry.id, id === "on")
        : id === "reload"
          ? props.host.reload(entry.id)
          : id === "folder"
            ? openFolder(entry.folder).then((opened) => {
                if (!opened) props.api.notify("Could not open the folder")
              })
            : null
    done?.catch((error: unknown) => props.api.notify(error instanceof Error ? error.message : String(error)))
  }

  return (
    <TwoPane
      api={props.api}
      sections={sections()}
      searchPlaceholder="Search mods"
      empty={(query) => (query ? `No mods match "${query}".` : "No mods yet. Put one in ~/.config/yellowcode/mods/.")}
      detail={(row, width) => {
        const entry = entryFor(row)
        return entry ? detailItems(entry, width, props.host.settings(entry.id), editing()) : []
      }}
      actions={(row) => {
        const entry = entryFor(row)
        return entry ? actions(entry) : []
      }}
      onAction={(row, action) => {
        const entry = entryFor(row)
        if (entry) run(entry, action.id)
      }}
      onKey={(key, row, query) => {
        const entry = entryFor(row)
        if (!entry) return false
        // While a search is typed, space and r are part of it.
        if (key.name === "space" && !query) run(entry, entry.status === "off" ? "on" : "off")
        else if (key.name === "r" && !key.ctrl && !key.meta && !query) run(entry, "reload")
        else if (key.name === "return") run(entry, "folder")
        else return false
        return true
      }}
      footer={() => FOOTER}
      actionsOnTop
      onDetailKey={detailKey}
      detailFooter={(row, focused) => {
        const name = settingKey(focused)
        const typing = editing()
        if (typing) return typing.capture ? CAPTURE_FOOTER : TYPING_FOOTER
        if (name === null) return null
        const type = props.host.settings(row.id)?.definitions[name]?.type
        return type === "text" || type === "key" ? TEXT_FOOTER : SETTING_FOOTER
      }}
    />
  )
}
