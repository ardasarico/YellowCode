import type { SettingChange, SettingRow, SettingValue } from "../../agent/settings.ts"

// Claude Code's own settings that change how it works in YellowCode too. Only claude's /config, /output-style and
// /autocompact change them (update_settings refuses these keys), and get_settings reads them back under other names.
// get_settings leaves out a value never set; it then reads as the default claude uses for it.

type ClaudeOption = { value: string; label: string }

// `plan` is the initialize reply's subscriptionType, such as "Claude Pro".
type ClaudeAccount = { model: string | null; plan: string | null }

type ClaudeSetting = {
  id: string
  label: string
  options: ClaudeOption[]
  read: (effective: Record<string, unknown>, account: ClaudeAccount) => string
  command: (value: string) => string
}

const ON_OFF: ClaudeOption[] = [
  { value: "true", label: "on" },
  { value: "false", label: "off" },
]

const flag = (effective: Record<string, unknown>, key: string, fallback: boolean) => {
  const value = effective[key]
  return String(typeof value === "boolean" ? value : fallback)
}

const named = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback)

const toggle = (id: string, label: string, configKey: string, storedKey: string): ClaudeSetting => ({
  id,
  label,
  options: ON_OFF,
  read: (effective) => flag(effective, storedKey, true),
  command: (value) => `/config ${configKey}=${value}`,
})

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}

const CLAUDE_SETTINGS: ClaudeSetting[] = [
  {
    id: "outputStyle",
    label: "Output style",
    options: ["default", "Proactive", "Concise", "Explanatory", "Learning"].map((value) => ({ value, label: value })),
    read: (effective) => named(effective["outputStyle"], "default"),
    command: (value) => `/output-style ${value}`,
  },
  {
    id: "autoCompactWindow",
    label: "Auto-compact window",
    options: [
      { value: "auto", label: "auto" },
      { value: "200000", label: "200k" },
      { value: "500000", label: "500k" },
      { value: "1000000", label: "1m" },
    ],
    read: (effective, { model }) => {
      const window =
        record(record(effective["modelSettings"])[model ?? ""])["autoCompactWindow"] ?? effective["autoCompactWindow"]
      return typeof window === "number" ? String(window) : named(window, "auto")
    },
    command: (value) => `/autocompact ${value}`,
  },
  toggle("autoCompact", "Auto-compact", "autoCompact", "autoCompactEnabled"),
  toggle("checkpoints", "Checkpoints", "checkpoints", "fileCheckpointingEnabled"),
  {
    id: "language",
    label: "Language",
    options: ["English", "Turkish", "German", "French", "Spanish", "Japanese", "Chinese"].map((value) => ({
      value,
      label: value,
    })),
    read: (effective) => named(effective["language"], "English"),
    command: (value) => `/config language=${value}`,
  },
  {
    id: "switchModelsOnFlag",
    label: "Flagged message",
    options: [
      { value: "true", label: "switch models" },
      { value: "false", label: "ask each time" },
    ],
    read: (effective) => flag(effective, "switchModelsOnFlag", true),
    command: (value) => `/config switchModelsOnFlag=${value === "true" ? "Switch automatically" : "Ask each time"}`,
  },
  toggle("useAutoModeDuringPlan", "Auto mode in plan", "useAutoModeDuringPlan", "useAutoModeDuringPlan"),
  {
    ...toggle("workflows", "Workflows", "workflows", "enableWorkflows"),
    // Off by default on the Pro plan only.
    read: (effective, { plan }) =>
      effective["disableWorkflows"] === true ? "false" : flag(effective, "enableWorkflows", plan !== "Claude Pro"),
  },
  toggle(
    "workflowKeywordTriggerEnabled",
    "Ultracode keyword",
    "workflowKeywordTriggerEnabled",
    "workflowKeywordTriggerEnabled",
  ),
  {
    id: "worktreeBaseRef",
    label: "Worktree base",
    options: [
      { value: "fresh", label: "fresh" },
      { value: "head", label: "head" },
    ],
    read: (effective) => named(record(effective["worktree"])["baseRef"], "fresh"),
    command: (value) => `/config worktreeBaseRef=${value}`,
  },
]

// Claude Code's rows for /settings, from what get_settings read; null when it could not be read, which leaves every
// value unknown but the rows still writable.
export function settingRows(effective: Record<string, unknown> | null, account: ClaudeAccount): SettingRow[] {
  return CLAUDE_SETTINGS.map((setting) => ({
    id: setting.id,
    label: setting.label,
    section: "",
    note: null,
    control: { type: "choice", options: setting.options },
    value: effective === null ? null : setting.read(effective, account),
    writable: true,
    applies: "now",
    origin: null,
    overriddenBy: null,
  }))
}

// The command claude takes for a change, or null for a row it does not have.
export function settingMessage(id: string, value: SettingValue): string | null {
  const setting = CLAUDE_SETTINGS.find((entry) => entry.id === id)
  return setting && value !== null ? setting.command(String(value)) : null
}

// The setting a /config, /output-style or /autocompact message changes and the value's label, for its chat row.
export function settingChange(text: string): SettingChange | null {
  for (const setting of CLAUDE_SETTINGS)
    for (const option of setting.options)
      if (setting.command(option.value) === text) return { label: setting.label, value: option.label }
  return null
}
