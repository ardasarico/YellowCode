import type { KeyEvent } from "@opentui/core"
import { createSignal, onMount } from "solid-js"
import type { ModSettingDefinition, ModSettingValue } from "../../mods/api.ts"
import type { ModEntry, ModHost, ModStatus } from "../../mods/host.ts"
import { keyText } from "../../mods/keys.ts"
import { apiMatches, revokedListing } from "../../mods/install/checks.ts"
import type { ListedMod } from "../../mods/install/list.ts"
import { forAgent, incompatibleText } from "../../mods/manifest.ts"
import { installedNow, installListed, modList, refreshModList, updatedTo } from "../../mods/mods.ts"
import { counts, modKeys, modPanes, modServerErrors } from "../../mods/registry.ts"
import type { SettingsHandle } from "../../mods/settings.ts"
import { configPath } from "../../config-path.ts"
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
import type { AgentOption } from "./options.ts"

const STACK_LINES = 8
const SETTING = "setting:"
// A listed mod that is not loaded: on offer, or installed from here and waiting for a restart.
const LISTED = "listed:"
const RETRY = "list-retry"
const RESTART = "restart to load"

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
    revoked: { mark: "⊘", color: theme.error },
    elsewhere: { mark: "◯", color: theme.panelFaint },
  })[status]

const nameOf = (entry: ModEntry) => entry.manifest?.name ?? entry.id
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

function listRow(entry: ModEntry): DialogRow {
  const { mark, color } = look(entry.status)
  return {
    id: entry.id,
    label: nameOf(entry),
    search: `${entry.id} ${nameOf(entry)} ${entry.manifest?.description ?? ""}`,
    marker: { text: mark, fg: color },
    tag: entry.source === "unlisted" ? "Unlisted" : entry.source === "local" ? "Local" : undefined,
    labelColor: entry.status === "on" ? undefined : entry.status === "off" ? theme.panelFaint : color,
    value: updatedTo[entry.id] ? `updated to ${updatedTo[entry.id]}` : entry.manifest?.version,
    valueColor: updatedTo[entry.id] ? theme.accent : theme.panelFaint,
  }
}

function listedRow(mod: ListedMod, installing: boolean, agent: AgentOption): DialogRow {
  const installed = installedNow[mod.id] !== undefined
  const fits = apiMatches(mod.api)
  const value = installed
    ? RESTART
    : installing
      ? "installing…"
      : !fits
        ? (incompatibleText(mod.api).split(" · ")[0] ?? "")
        : forAgent(mod, agent.id)
          ? mod.version
          : "not for this agent"
  return {
    id: `${LISTED}${mod.id}`,
    label: mod.name,
    search: `${mod.id} ${mod.name} ${mod.description}`,
    marker: installed ? { text: "●", fg: theme.accent } : undefined,
    value,
    valueColor: installed || installing ? theme.accent : fits ? theme.panelFaint : theme.warning,
  }
}

const agentsText = (mod: ListedMod, agents: AgentOption[]) =>
  mod.agents === "any"
    ? "any agent"
    : mod.agents.map((id) => agents.find((agent) => agent.id === id)?.name ?? id).join(", ")

function listedDetail(mod: ListedMod, width: number, agent: AgentOption, agents: AgentOption[]): DialogItem[] {
  const installed = installedNow[mod.id] !== undefined
  const fits = apiMatches(mod.api)
  const state: Span = installed
    ? { text: RESTART, fg: theme.accent }
    : fits
      ? { text: "not installed", fg: theme.panelFaint }
      : { text: incompatibleText(mod.api), fg: theme.warning }
  return [
    header(`${mod.name} ${mod.version}`, state),
    ...(mod.description ? [text("description", [{ text: mod.description, fg: theme.text }])] : []),
    ...fact("agents", "Agents", agentsText(mod, agents), width, forAgent(mod, agent.id) ? theme.text : theme.warning),
    ...(installed ? fact("source", "Source", tildePath(`${configPath("mods")}/${mod.id}`), width) : []),
    ...fact("repo", "Repo", `github.com/${mod.repo}`, width),
    ...fact("commit", "Commit", mod.sha.slice(0, 7), width),
  ]
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
      : entry.status === "incompatible" || entry.status === "revoked" || entry.status === "elsewhere"
        ? (entry.problem ?? entry.status)
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

// A shortcut of one character with no ctrl or alt takes that character everywhere, the prompt included.
function bareKeys(mod: string, width: number): DialogItem[] {
  return modKeys()
    .filter((key) => key.mod === mod && key.when !== "pane" && !key.binding.ctrl && !key.binding.meta)
    .filter((key) => Array.from(key.binding.name).length === 1)
    .flatMap((key) =>
      fact(
        `bare-${key.key}`,
        "Shortcut",
        `${key.key} takes that key everywhere, also while typing`,
        width,
        theme.warning,
      ),
    )
}

function detailItems(entry: ModEntry, width: number, settings: SettingsHandle | null, editing: Editing | null) {
  const manifest = entry.manifest
  const heading = manifest ? `${manifest.name} ${manifest.version}` : entry.id
  const description = manifest?.description
    ? [text("description", [{ text: manifest.description, fg: theme.text }])]
    : []
  const adds = counts(entry.id, entry.status === "on" ? Object.keys(manifest?.mcpServers ?? {}).length : 0)
  return [
    header(heading, statusSpan(entry)),
    ...description,
    ...(updatedTo[entry.id]
      ? fact("updated", "Update", `updated to ${updatedTo[entry.id]} · restart to load`, width, theme.accent)
      : []),
    ...fact("source", "Source", tildePath(entry.folder), width),
    ...fact("adds", "Adds", adds.length > 0 ? adds.join(" · ") : "nothing", width),
    ...fact("load", "Load time", entry.loadMs === null ? "—" : `${entry.loadMs} ms`, width),
    ...Object.entries(modServerErrors())
      .filter(([server]) => server === `mod-${entry.id}` || server.startsWith(`mod-${entry.id}--`))
      .flatMap(([server, error]) => fact(`mcp-${server}`, "MCP", `${server}: ${error}`, width, theme.error)),
    ...(modPanes().some((pane) => pane.mod === entry.id && crowded().has(pane.key))
      ? fact("room", "Pane", "no room in this window", width, theme.warning)
      : []),
    ...bareKeys(entry.id, width),
    ...errorLines(entry, width),
    ...settingItems(settings, editing, width),
  ]
}

function actions(entry: ModEntry): DialogRow[] {
  const folder = { id: "folder", label: "Open folder" }
  const reload = { id: "reload", label: "Reload" }
  if (entry.status === "off") return [{ id: "on", label: "Turn on" }, folder]
  if (entry.status === "incompatible" || entry.status === "revoked" || entry.status === "elsewhere")
    return [reload, folder]
  return [{ id: "off", label: "Turn off" }, reload, folder]
}

const SETTING_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "←→/space", action: "change" },
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
  { key: "→", action: "settings" },
  { key: "space", action: "on/off" },
  { key: "ctrl+r", action: "reload" },
  { key: "ctrl+o", action: "open folder" },
  { key: "esc", action: "close" },
]
const AVAILABLE_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "enter", action: "install" },
  { key: "ctrl+r", action: "refresh list" },
  { key: "esc", action: "close" },
]
const INSTALLED_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "ctrl+o", action: "open folder" },
  { key: "esc", action: "close" },
]
const RETRY_FOOTER: FooterAction[] = [
  { key: "↑↓", action: "select" },
  { key: "ctrl+r", action: "retry" },
  { key: "esc", action: "close" },
]

// `agent` is the one the mods load for; `agents` gives the names of the others a listed mod names.
export function ModsTab(props: { api: TabApi; host: ModHost; agent: AgentOption; agents: AgentOption[] }) {
  const [editing, setEditing] = createSignal<Editing | null>(null)
  onMount(refreshModList)

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
    else if (key.name === "space") changeSetting(settings, name, 1)
    else return false
    return true
  }

  const [installing, setInstalling] = createSignal<string | null>(null)

  const entryFor = (row: DialogRow | undefined) => props.host.entries.find((entry) => entry.id === row?.id)
  const installed = () =>
    Object.values(installedNow).filter((mod) => !props.host.entries.some((entry) => entry.id === mod.id))
  // Listed mods that are not installed; revoked ones are left out.
  const available = () => {
    const list = modList().list
    if (!list) return []
    return list.mods.filter(
      (mod) =>
        installedNow[mod.id] === undefined &&
        !props.host.entries.some((entry) => entry.id === mod.id) &&
        revokedListing(list, mod.id, mod.version) === null,
    )
  }
  const listedFor = (row: DialogRow | undefined) =>
    row?.id.startsWith(LISTED)
      ? (installedNow[row.id.slice(LISTED.length)] ?? available().find((mod) => `${LISTED}${mod.id}` === row.id))
      : undefined

  const availableRows = (): DialogItem[] => {
    const state = modList()
    if (!state.list && state.failed)
      return [{ id: RETRY, label: "Couldn't reach the mod list · ctrl+r retry", labelColor: theme.panelMuted }]
    if (!state.list) return [text("list-loading", [{ text: "Getting the mod list…", fg: theme.panelMuted }])]
    return available()
      .toSorted(byName)
      .map((mod) => listedRow(mod, installing() === mod.id, props.agent))
  }
  const sections = (): DialogSection[] => {
    const mine: DialogItem[] = props.host.entries
      .map((entry) => ({ name: nameOf(entry), row: listRow(entry) }))
      .concat(installed().map((mod) => ({ name: mod.name, row: listedRow(mod, false, props.agent) })))
      .toSorted(byName)
      .map(({ row }) => row)
    const offered = availableRows()
    if (mine.length > 0 && offered.length > 0) mine.push(blank("gap-available"))
    return [
      { title: "", rows: mine },
      { title: "Available", rows: offered },
    ]
  }

  const install = async (mod: ListedMod) => {
    if (installing() !== null || !apiMatches(mod.api)) return
    const yes = await props.api.confirm({
      title: "Install mod",
      message: `Install ${mod.name} ${mod.version} from github.com/${mod.repo} at ${mod.sha.slice(0, 7)}? It loads the next time YellowCode starts.`,
      action: "Install",
    })
    if (!yes) return
    setInstalling(mod.id)
    try {
      await installListed(mod)
      props.api.notify(`Installed ${mod.name} · ${RESTART}`)
    } catch (error) {
      props.api.notify(error instanceof Error ? error.message : String(error))
    } finally {
      setInstalling(null)
    }
  }

  const listedAction = (row: DialogRow, id: string) => {
    const mod = listedFor(row)
    if (id === "retry") refreshModList()
    else if (mod && id === "install") void install(mod)
    else if (mod && id === "folder")
      void openFolder(`${configPath("mods")}/${mod.id}`).then((opened) => {
        if (!opened) props.api.notify("Could not open the folder")
      })
  }

  const listedKey = (key: KeyEvent, row: DialogRow | undefined, query: string): boolean => {
    if (row?.id !== RETRY && !row?.id.startsWith(LISTED)) return false
    const mod = listedFor(row)
    const done = mod !== undefined && installedNow[mod.id] !== undefined
    if (key.ctrl && key.name === "r") refreshModList()
    else if (key.ctrl && key.name === "o") listedAction(row, "folder")
    else if (key.name === "return" && mod && !done && apiMatches(mod.api)) void install(mod)
    else return key.name === "space" && !query
    return true
  }

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
      empty={(query) =>
        query ? `No mods match "${query}".` : `No mods yet. Put one in ${tildePath(configPath("mods"))}/.`
      }
      detail={(row, width) => {
        const entry = entryFor(row)
        if (entry) return detailItems(entry, width, props.host.settings(entry.id), editing())
        const mod = listedFor(row)
        if (mod) return listedDetail(mod, width, props.agent, props.agents)
        return row.id === RETRY
          ? [text("retry", [{ text: "The mod list could not be fetched and none is cached.", fg: theme.text }])]
          : []
      }}
      actions={(row) => {
        const entry = entryFor(row)
        if (entry) return actions(entry)
        const mod = listedFor(row)
        if (row.id === RETRY) return [{ id: "retry", label: "Retry" }]
        if (!mod) return []
        if (installedNow[mod.id]) return [{ id: "folder", label: "Open folder" }]
        return apiMatches(mod.api) ? [{ id: "install", label: "Install" }] : []
      }}
      onAction={(row, action) => {
        const entry = entryFor(row)
        if (entry) run(entry, action.id)
        else listedAction(row, action.id)
      }}
      onKey={(key, row, query) => {
        if (listedKey(key, row, query)) return true
        const entry = entryFor(row)
        if (!entry) return false
        // While a search is typed, space is part of it.
        // A mod that cannot load here has no on/off, so it is not saved as off for later.
        if (key.name === "space" && !query) {
          const toggle = actions(entry).find((action) => action.id === "on" || action.id === "off")
          if (toggle) run(entry, toggle.id)
        } else if (key.ctrl && key.name === "r") run(entry, "reload")
        else if (key.ctrl && key.name === "o") run(entry, "folder")
        else return false
        return true
      }}
      footer={(row) => {
        if (row.id === RETRY) return RETRY_FOOTER
        const mod = listedFor(row)
        if (!mod) return FOOTER
        if (installedNow[mod.id]) return INSTALLED_FOOTER
        return apiMatches(mod.api) ? AVAILABLE_FOOTER : AVAILABLE_FOOTER.filter((item) => item.key !== "enter")
      }}
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
