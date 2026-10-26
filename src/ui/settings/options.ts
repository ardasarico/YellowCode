import { setSetting, settings } from "../../session/settings.ts"
import { PERMISSION_MODES, type PermissionMode, type StoredSettings } from "../../session/settings-file.ts"
import { setTheme, theme, themeEntries, themeId } from "../../theme/theme.ts"
import type { DialogItem, DialogSection } from "../dialog/list.ts"
import { editorChoices, editorName } from "../dialog/open-file.ts"

type SettingOption<V extends string = string> = { value: V; label: string; note?: string; tag?: string }

// The settings picked from a list; disabledMods is changed in /mods.
type ChoiceKey = { [K in keyof StoredSettings]: StoredSettings[K] extends string ? K : never }[keyof StoredSettings]

type Definition<K extends ChoiceKey> = {
  key: K
  section: string
  label: string
  options: SettingOption<StoredSettings[K]>[]
}

export type SettingDefinition = { [K in ChoiceKey]: Definition<K> }[ChoiceKey]

const NOTES: Partial<Record<PermissionMode, string>> = {
  bypassPermissions: "Every tool runs without asking.",
  dontAsk: "Tools not pre-approved are denied without asking.",
}

const same = <V extends string>(values: readonly V[]): SettingOption<V>[] =>
  values.map((value) => ({ value, label: value }))

export const SETTINGS: SettingDefinition[] = [
  {
    key: "theme",
    section: "Appearance",
    label: "Theme",
    get options() {
      return themeEntries()
        .filter((entry) => entry.problem === null)
        .map(({ id, name, source }) => ({ value: id, label: name, tag: source === "user" ? "user" : undefined }))
    },
  },
  { key: "sidebar", section: "Appearance", label: "Sidebar", options: same(["auto", "shown", "hidden"]) },
  { key: "thinking", section: "Appearance", label: "Thinking", options: same(["summarized", "hidden"]) },
  {
    key: "sessionTitle",
    section: "Session",
    label: "Session title",
    options: [
      { value: "yellowcode", label: "YellowCode" },
      { value: "claude-code", label: "Claude Code" },
    ],
  },
  {
    key: "permissionMode",
    section: "Session",
    label: "Permission mode",
    options: PERMISSION_MODES.map((value) => ({ value, label: value, note: NOTES[value] })),
  },
  {
    key: "editor",
    section: "Session",
    label: "Open files in",
    get options() {
      return editorChoices(settings.editor).map((value) => ({ value, label: editorName(value) }))
    },
  },
  {
    key: "notifications",
    section: "Session",
    label: "Notifications",
    options: [
      { value: "all", label: "All" },
      { value: "waiting", label: "Only when waiting" },
      { value: "off", label: "Off" },
    ],
  },
]

export const LONG = 3

export const settingFor = (id: string) => SETTINGS.find((setting) => setting.key === id)
export const opensList = (setting: SettingDefinition) => setting.options.length > LONG

export function currentOption(setting: SettingDefinition): SettingOption | undefined {
  const saved = settings[setting.key]
  const found = setting.options.find((option) => option.value === saved)
  if (found || setting.key !== "theme") return found ?? setting.options[0]
  return { value: saved, label: `${saved} (not found)` }
}

export function step(setting: SettingDefinition, by: 1 | -1) {
  const count = setting.options.length
  const index = Math.max(
    0,
    setting.options.findIndex((option) => option.value === settings[setting.key]),
  )
  const next = setting.options[(index + by + count) % count]
  if (next) setSetting(setting.key, next.value)
}

export function choose(setting: SettingDefinition, value: string) {
  const option = setting.options.find((candidate) => candidate.value === value)
  if (option) setSetting(setting.key, option.value)
}

export const optionSections = (setting: SettingDefinition, title = setting.label): DialogSection[] => [
  {
    title,
    rows: [
      ...setting.options.map((option) => ({
        id: option.value,
        label: option.label,
        value: option.value === settings[setting.key] ? "current" : undefined,
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
      : [{ id: `broken-${entry.id}`, spans: [{ text: `  ${entry.name} · ${entry.problem}`, fg: theme.warning }] }],
  )

export const preview = (id: string) => {
  if (id !== themeId()) setTheme(id)
}
