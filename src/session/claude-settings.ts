// Claude Code's own settings that change how it works in YellowCode too. Only claude's /config, /output-style and
// /autocompact change them (update_settings refuses these keys), and get_settings reads them back under other names.
// A value never set reads as null, shown as "default": claude's defaults are not guessed.

export type ClaudeOption = { value: string; label: string }

export type ClaudeSetting = {
  id: string
  label: string
  options: ClaudeOption[]
  read: (effective: Record<string, unknown>, model: string | null) => string | null
  command: (value: string) => string
}

const ON_OFF: ClaudeOption[] = [
  { value: "true", label: "on" },
  { value: "false", label: "off" },
]

const flag = (key: string) => (effective: Record<string, unknown>) => {
  const value = effective[key]
  return typeof value === "boolean" ? String(value) : null
}

const toggle = (id: string, label: string, configKey: string, storedKey: string): ClaudeSetting => ({
  id,
  label,
  options: ON_OFF,
  read: flag(storedKey),
  command: (value) => `/config ${configKey}=${value}`,
})

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}

export const CLAUDE_SETTINGS: ClaudeSetting[] = [
  {
    id: "outputStyle",
    label: "Output style",
    options: ["default", "Proactive", "Concise", "Explanatory", "Learning"].map((value) => ({ value, label: value })),
    read: (effective) => (typeof effective["outputStyle"] === "string" ? effective["outputStyle"] : null),
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
    read: (effective, model) => {
      const window = record(record(effective["modelSettings"])[model ?? ""])["autoCompactWindow"]
      return typeof window === "number" ? String(window) : null
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
    read: (effective) => (typeof effective["language"] === "string" ? effective["language"] : null),
    command: (value) => `/config language=${value}`,
  },
  {
    id: "switchModelsOnFlag",
    label: "Flagged message",
    options: [
      { value: "true", label: "switch models" },
      { value: "false", label: "ask each time" },
    ],
    read: flag("switchModelsOnFlag"),
    command: (value) => `/config switchModelsOnFlag=${value === "true" ? "Switch automatically" : "Ask each time"}`,
  },
  toggle("useAutoModeDuringPlan", "Auto mode in plan", "useAutoModeDuringPlan", "useAutoModeDuringPlan"),
  toggle("workflows", "Workflows", "workflows", "enableWorkflows"),
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
    read: (effective) => {
      const ref = record(effective["worktree"])["baseRef"]
      return typeof ref === "string" ? ref : null
    },
    command: (value) => `/config worktreeBaseRef=${value}`,
  },
]

// The setting a /config, /output-style or /autocompact message changes and the value's label, for its chat row.
export function claudeChange(text: string): { label: string; value: string } | null {
  for (const setting of CLAUDE_SETTINGS)
    for (const option of setting.options)
      if (setting.command(option.value) === text) return { label: setting.label, value: option.label }
  return null
}
