import type { ModEntry, ModHost, ModStatus } from "../../mods/host.ts"
import { tildePath } from "../../rewind/common.ts"
import { theme } from "../../theme/theme.ts"
import { blank, fact, header, text, title } from "../dialog/detail.ts"
import type { DialogItem, DialogRow, DialogSection } from "../dialog/list.ts"
import type { FooterAction } from "../dialog/list-view.tsx"
import { openFolder } from "../dialog/open-file.ts"
import type { TabApi } from "../dialog/tabbed-dialog.tsx"
import { TwoPane } from "../dialog/two-pane.tsx"
import { cut } from "../format.ts"
import type { Span } from "../notice.ts"

const STACK_LINES = 8

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
      ? entry.error
        ? "failed at setup"
        : "failed"
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

function detailItems(entry: ModEntry, width: number): DialogItem[] {
  const manifest = entry.manifest
  const heading = manifest ? `${manifest.name} ${manifest.version}` : entry.id
  const description = manifest?.description
    ? [text("description", [{ text: manifest.description, fg: theme.text }])]
    : []
  return [
    header(heading, statusSpan(entry)),
    ...description,
    blank("gap-head"),
    ...fact("source", "Source", tildePath(entry.folder), width),
    ...fact("adds", "Adds", "nothing yet", width),
    ...fact("load", "Load time", entry.loadMs === null ? "—" : `${entry.loadMs} ms`, width),
    ...errorLines(entry, width),
  ]
}

function actions(entry: ModEntry): DialogRow[] {
  const folder = { id: "folder", label: "Open folder" }
  const reload = { id: "reload", label: "Reload" }
  if (entry.status === "off") return [{ id: "on", label: "Turn on" }, folder]
  if (entry.status === "incompatible") return [reload, folder]
  return [{ id: "off", label: "Turn off" }, reload, folder]
}

const FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "space", action: "on/off" },
  { key: "r", action: "reload" },
  { key: "enter", action: "open folder" },
  { key: "esc", action: "close" },
]

export function ModsTab(props: { api: TabApi; host: ModHost }) {
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
        return entry ? detailItems(entry, width) : []
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
    />
  )
}
