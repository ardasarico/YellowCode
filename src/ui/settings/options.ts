import { PERMISSION_MODES, type PermissionMode, type StoredSettings } from "../../session/settings-file.ts"
import { themes } from "../../theme/theme.ts"

export type SettingOption<V extends string = string> = { value: V; label: string; note?: string }

type Definition<K extends keyof StoredSettings> = {
  key: K
  section: string
  label: string
  options: SettingOption<StoredSettings[K]>[]
}

export type SettingDefinition = { [K in keyof StoredSettings]: Definition<K> }[keyof StoredSettings]

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
    options: themes.map(({ id, name }) => ({ value: id, label: name })),
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
]
