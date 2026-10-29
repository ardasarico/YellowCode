export type SettingValue = boolean | number | string | null

export type SettingControl =
  | { type: "toggle" }
  | { type: "choice"; options: { value: string; label: string }[] }
  | { type: "number"; min: number | null; max: number | null; step: number; unit: string | null }
  | { type: "text" }

// Rows every agent that has the setting shows in the same place, under these ids.
export const SHARED_SETTINGS = ["compaction.auto", "compaction.threshold", "web-search"] as const

// One of the agent's own settings in /settings, read through the adapter's allowlist.
export type SettingRow = {
  id: string
  label: string
  // Rows with the same section sit under one heading inside the agent's group.
  section: string
  note: string | null
  control: SettingControl
  value: SettingValue
  // False: shown read-only, with the file to open in the editor.
  writable: boolean
  applies: "now" | "new-session"
  // The file the value comes from and its layer (user, project, managed, …).
  origin: { file: string; layer: string } | null
  // The layer whose value wins over a write, such as the project file.
  overriddenBy: string | null
}
