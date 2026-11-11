import type { SessionEntry } from "../../agent/sessions.ts"
import { type Command, matchCommands } from "../../input/commands.ts"
import type { PickerModel } from "../../models/picker.ts"
import { formatAgo, NO_PROMPT } from "../format.ts"
import type { SessionList } from "../resume/rows.ts"
import type { SettingDefinition } from "../settings/options.ts"

export type PaletteKind = "command" | "action" | "model" | "session" | "setting"

export type ActionId = "sidebar" | "ultracode" | "agents" | "mode" | "effort-up" | "effort-down" | "background"

// `fill`: the command needs an argument, so it is written into the prompt instead of run.
export type PaletteTarget =
  | { kind: "command"; name: string; fill: boolean }
  | { kind: "action"; action: ActionId }
  | { kind: "model"; model: PickerModel }
  | { kind: "session"; entry: SessionEntry }
  | { kind: "setting"; row: string }

export type PaletteRow = {
  id: string
  name: string
  description: string
  shortcut?: string
  aliases?: string[]
  // More text a search finds the row by.
  search?: string
  // Left out of the list until a search finds it.
  searchOnly?: boolean
  target: PaletteTarget
}

// `match` is the typed run inside the name, or inside the alias on an alias row.
export type RankedRow = { row: PaletteRow; match: { start: number; end: number } | null; alias?: string }

const ACTIONS: { action: ActionId; name: string; description: string; shortcut: string }[] = [
  { action: "sidebar", name: "Toggle sidebar", description: "Show or hide the sidebar", shortcut: "f3" },
  { action: "ultracode", name: "Toggle ultracode", description: "Turn ultracode on or off", shortcut: "f4" },
  { action: "agents", name: "Agent panel", description: "Agents and shells in the background", shortcut: "ctrl+t" },
  { action: "mode", name: "Next permission mode", description: "", shortcut: "shift+tab" },
  { action: "effort-up", name: "More effort", description: "", shortcut: "shift+↑" },
  { action: "effort-down", name: "Less effort", description: "", shortcut: "shift+↓" },
  { action: "background", name: "Send to background", description: "What is running now", shortcut: "ctrl+b" },
]

const RECENT_SESSIONS = 10

// "<name>" must be given; "[name]" may be left out.
const needsArgument = (hint: string) => hint.trim() !== "" && !hint.trim().startsWith("[")

// A skill or a custom command shows once it is searched for.
const commandRow = (command: Command): PaletteRow => ({
  id: `command:${command.name}`,
  name: command.name,
  description: command.description.replace(/\s+/g, " ").trim(),
  aliases: command.aliases,
  searchOnly: command.builtin === false,
  target: { kind: "command", name: command.name, fill: needsArgument(command.argumentHint) },
})

const settingValue = (setting: SettingDefinition) =>
  setting.options.find((option) => option.value === setting.value())?.label ?? setting.value()

export type PaletteSource = {
  commands: Command[]
  // Whether each keyboard action can run now.
  actions: Record<ActionId, boolean>
  models: { model: PickerModel; provider: string; current: boolean }[]
  // Newest first.
  sessions: SessionList
  settings: SettingDefinition[]
  now: number
}

// Every row of the palette, in the order an empty search shows them: YellowCode's and the mods' commands, the
// keyboard actions, then the provider's commands and the rest.
export function paletteRows(source: PaletteSource): PaletteRow[] {
  const { names } = source.sessions
  const own = source.commands.filter((command) => command.builtin === undefined)
  const listed = source.commands.filter((command) => command.builtin !== undefined)
  return [
    ...own.map(commandRow),
    ...ACTIONS.filter(({ action }) => source.actions[action]).map(
      ({ action, name, description, shortcut }): PaletteRow => ({
        id: `action:${action}`,
        name,
        description,
        shortcut,
        target: { kind: "action", action },
      }),
    ),
    ...listed.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(commandRow),
    ...source.models.map(({ model, provider, current }): PaletteRow => ({
      id: `model:${model.provider}:${model.id}`,
      name: model.label,
      description: current ? `${provider} · current` : provider,
      search: model.id,
      target: { kind: "model", model },
    })),
    ...source.sessions.entries.map((entry, index): PaletteRow => ({
      id: `session:${entry.ref.agent}:${entry.ref.id}`,
      name: entry.title || NO_PROMPT,
      description: [names?.[entry.ref.agent], formatAgo(entry.modified, source.now)].filter(Boolean).join(" · "),
      search: entry.firstPrompt,
      searchOnly: index >= RECENT_SESSIONS,
      target: { kind: "session", entry },
    })),
    ...source.settings.map((setting): PaletteRow => ({
      id: `setting:${setting.key}`,
      name: setting.label,
      description: settingValue(setting),
      search: setting.section,
      target: { kind: "setting", row: setting.key },
    })),
  ]
}

// The command matcher splits names at - _ and : only; these stand in for the other word breaks, at the same offsets.
const asCommandName = (text: string) => text.replace(/[\s/.]/g, "-")

// Exact names first, then names that start with the search, names with a word that starts with it, aliases, names
// that hold it and last the rows whose other text holds it. A search that starts with "/" is for commands only.
export function rankRows(rows: PaletteRow[], query: string): RankedRow[] {
  const typed = query.trim().toLowerCase()
  const needle = typed.startsWith("/") ? typed.slice(1) : typed
  const pool = typed.startsWith("/") ? rows.filter((row) => row.target.kind === "command") : rows
  if (!needle) return pool.filter((row) => !row.searchOnly).map((row) => ({ row, match: null }))
  const tiers: RankedRow[][] = [[], [], [], [], [], []]
  for (const row of pool) {
    const name = row.name.toLowerCase()
    const [found] = matchCommands(
      [{ name: asCommandName(name), description: "", argumentHint: "", aliases: row.aliases ?? [] }],
      asCommandName(needle),
    )
    const inside = name.indexOf(needle)
    if (found?.alias !== undefined) tiers[3]?.push({ row, match: found.match, alias: found.alias })
    else if (found) tiers[name === needle ? 0 : found.match.start === 0 ? 1 : 2]?.push({ row, match: found.match })
    else if (inside >= 0) tiers[4]?.push({ row, match: { start: inside, end: inside + needle.length } })
    else if (`${row.description}\n${row.search ?? ""}`.toLowerCase().includes(needle))
      tiers[5]?.push({ row, match: null })
  }
  return tiers.flat()
}
