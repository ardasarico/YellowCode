import type { AgentKindId } from "../../agent/ids.ts"
import type { ModeRow } from "../../agent/lists.ts"
import {
  DEFAULT_SESSION_SETTINGS,
  defaultModeOf,
  resetDefaultMode,
  resetSetting,
  type SessionSettings,
  setDefaultMode,
  setSessionSettings,
  setSetting,
  settings,
} from "../../session/settings.ts"
import { MAX_SUBAGENTS, type StoredSettings } from "../../session/settings-file.ts"
import { setTheme, theme, themeEntries, themeId } from "../../theme/theme.ts"
import type { DialogItem, DialogSection } from "../dialog/list.ts"
import { editorChoices, editorName } from "../dialog/open-file.ts"
import { defaultChannel, installMethod } from "../../update/method.ts"
import { channelChanged } from "../../update/updater.ts"

type SettingOption<V extends string = string> = { value: V; label: string; note?: string; tag?: string }

// The settings picked from a list; disabledMods is changed in /mods.
type ChoiceKey = { [K in keyof StoredSettings]-?: StoredSettings[K] extends string ? K : never }[keyof StoredSettings]

type Stored<K extends ChoiceKey> = {
  key: K
  section: string
  label: string
  options: SettingOption<StoredSettings[K]>[]
}

export type SettingDefinition = {
  key: string
  section: string
  label: string
  readonly options: SettingOption[]
  value(): string
  set(value: string): void
  reset(): void
}

// The definition is read on every use, so options given by a getter stay current.
function stored<K extends ChoiceKey>(definition: Stored<K>): SettingDefinition {
  return {
    key: definition.key,
    section: definition.section,
    label: definition.label,
    get options() {
      return definition.options
    },
    value: () => settings[definition.key],
    set(value) {
      const option = definition.options.find((candidate) => candidate.value === value)
      if (option) setSetting(definition.key, option.value)
    },
    reset: () => resetSetting(definition.key),
  }
}

const same = <V extends string>(values: readonly V[]): SettingOption<V>[] =>
  values.map((value) => ({ value, label: value }))

export const THEME = stored({
  key: "theme",
  section: "Appearance",
  label: "Theme",
  get options() {
    return themeEntries()
      .filter((entry) => entry.problem === null)
      .map(({ id, name, source }) => ({ value: id, label: name, tag: source === "user" ? "user" : undefined }))
  },
})

// The mode the agent's new sessions start in, kept for that agent.
const defaultMode = (agent: AgentKindId, modes: ModeRow[]): SettingDefinition => ({
  key: "permissionMode",
  section: "Session",
  label: "Permission mode",
  options: modes.map(({ id, label, description }) => ({ value: id, label, note: description || undefined })),
  value: () => defaultModeOf(agent) ?? "",
  set(value) {
    if (modes.some((mode) => mode.id === value)) setDefaultMode(agent, value)
  },
  reset: () => resetDefaultMode(agent),
})

// An agent YellowCode can open, by its name.
export type AgentOption = { id: AgentKindId; name: string }

const SIDEBAR = stored<"sidebar">({
  key: "sidebar",
  section: "Appearance",
  label: "Sidebar",
  options: same(["auto", "shown", "hidden"]),
})

const THINKING = stored<"thinking">({
  key: "thinking",
  section: "Appearance",
  label: "Thinking",
  options: same(["summarized", "hidden"]),
})

const sessionTitle = (agentName: string) =>
  stored({
    key: "sessionTitle",
    section: "Session",
    label: "Session title",
    options: [
      { value: "yellowcode", label: "YellowCode" },
      { value: "agent", label: agentName },
    ],
  })

const EDITOR = stored({
  key: "editor",
  section: "Session",
  label: "Open files in",
  get options() {
    return editorChoices(settings.editor).map((value) => ({ value, label: editorName(value) }))
  },
})

const NOTIFICATIONS = stored({
  key: "notifications",
  section: "Session",
  label: "Notifications",
  options: [
    { value: "all", label: "All" },
    { value: "waiting", label: "Only when waiting" },
    { value: "off", label: "Off" },
  ],
})

function sessionSetting<K extends keyof SessionSettings>(
  key: K,
  label: string,
  options: SettingOption<SessionSettings[K]>[],
): SettingDefinition {
  return {
    key,
    section: "Other sessions",
    label,
    options,
    value: () => settings[key],
    set(value) {
      const option = options.find((candidate) => candidate.value === value)
      if (option) setSessionSettings({ [key]: option.value })
    },
    reset: () => setSessionSettings({ [key]: DEFAULT_SESSION_SETTINGS[key] }),
  }
}

const PEER_MESSAGES = sessionSetting("peerMessages", "Incoming messages", [
  { value: "run", label: "Run" },
  { value: "ask", label: "Ask first" },
])

const PEER_VISIBLE = sessionSetting("peerVisible", "Visible to them", [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
])

const SUBAGENTS: SettingDefinition = {
  key: "maxSubagents",
  section: "Session",
  label: "Subagents at once",
  options: Array.from({ length: MAX_SUBAGENTS }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1),
  })),
  value: () => String(settings.maxSubagents),
  set(value) {
    const count = Number(value)
    if (Number.isInteger(count) && count >= 1 && count <= MAX_SUBAGENTS) setSetting("maxSubagents", count)
  },
  reset: () => resetSetting("maxSubagents"),
}

const UPDATES: SettingDefinition = {
  key: "updates",
  section: "Updates",
  label: "Channel",
  options: [
    { value: "stable", label: "Stable" },
    {
      value: "beta",
      label: "Beta",
      note: installMethod() === "brew" ? "Homebrew has stable only; use install.sh or npm for beta" : undefined,
    },
  ],
  value: () => settings.updates ?? defaultChannel(),
  set(value) {
    if (value !== "stable" && value !== "beta") return
    const before = UPDATES.value()
    setSetting("updates", value)
    if (value !== before) channelChanged()
  },
  reset() {
    const before = UPDATES.value()
    resetSetting("updates")
    if (UPDATES.value() !== before) channelChanged()
  },
}

// YellowCode's own settings, with what it keeps for the agent among them.
export const settingsFor = (agent: AgentOption, modes: ModeRow[]): SettingDefinition[] => [
  THEME,
  SIDEBAR,
  THINKING,
  sessionTitle(agent.name),
  defaultMode(agent.id, modes),
  EDITOR,
  NOTIFICATIONS,
  SUBAGENTS,
  PEER_MESSAGES,
  PEER_VISIBLE,
  UPDATES,
]

export const LONG = 3

export const opensList = (setting: SettingDefinition) => setting.options.length > LONG

export function currentOption(setting: SettingDefinition): SettingOption | undefined {
  const saved = setting.value()
  const found = setting.options.find((option) => option.value === saved)
  if (found || setting.key !== "theme") return found ?? setting.options[0]
  return { value: saved, label: `${saved} (not found)` }
}

export function step(setting: SettingDefinition, by: 1 | -1) {
  const count = setting.options.length
  const index = Math.max(
    0,
    setting.options.findIndex((option) => option.value === setting.value()),
  )
  const next = setting.options[(index + by + count) % count]
  if (next) setting.set(next.value)
}

export const optionSections = (setting: SettingDefinition, title = setting.label): DialogSection[] => [
  {
    title,
    rows: [
      ...setting.options.map((option) => ({
        id: option.value,
        label: option.label,
        value: option.value === setting.value() ? "current" : undefined,
        note: option.note,
        tag: option.tag,
      })),
      ...(setting.key === "theme" ? brokenThemes() : []),
    ],
  },
]

// Theme files that did not load, with why; they cannot be picked.
const brokenThemes = (): DialogItem[] =>
  themeEntries().flatMap((entry) =>
    entry.problem === null
      ? []
      : [
          {
            id: `broken-${entry.id}`,
            spans: [{ text: `  ${entry.name} · ${entry.problem}`, fg: theme.warning }],
            search: entry.name,
          },
        ],
  )

export const preview = (id: string) => {
  if (id !== themeId()) setTheme(id)
}
