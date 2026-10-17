import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createSignal } from "solid-js"
import { z } from "zod"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { themes } from "../theme/theme.ts"

export const PERMISSION_MODES = ["auto", "manual", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export type SidebarSetting = "auto" | "shown" | "hidden"
export type ThinkingSetting = "summarized" | "hidden"
export type TitleSource = "yellowcode" | "claude-code"
export const EDITORS = ["default", "zed", "vscode", "cursor"] as const
export type Editor = (typeof EDITORS)[number]
export const NOTIFICATIONS = ["all", "waiting", "off"] as const
export type NotificationSetting = (typeof NOTIFICATIONS)[number]

export type StoredSettings = {
  theme: string
  sidebar: SidebarSetting
  thinking: ThinkingSetting
  sessionTitle: TitleSource
  permissionMode: PermissionMode
  editor: Editor
  notifications: NotificationSetting
}

export const DEFAULT_SETTINGS: StoredSettings = {
  theme: "terminal",
  sidebar: "auto",
  thinking: "summarized",
  sessionTitle: "yellowcode",
  permissionMode: "auto",
  editor: "default",
  notifications: "all",
}

const Stored = z.record(z.string(), z.unknown())

const Theme = z.string().refine((id) => themes.some((theme) => theme.id === id))
const Sidebar = z.enum(["auto", "shown", "hidden"])
const Thinking = z.enum(["summarized", "hidden"])
const SessionTitle = z.enum(["yellowcode", "claude-code"])
// "default" is the protocol's name for the mode the CLI calls "manual".
const Permission = z.preprocess((mode) => (mode === "default" ? "manual" : mode), z.enum(PERMISSION_MODES))
const EditorSchema = z.enum(EDITORS)
const Notifications = z.enum(NOTIFICATIONS)

export type LoadedSettings = { settings: StoredSettings; problem: string | null }

export const SAVE_PROBLEM = "cannot save settings.json, changes last until you quit"
// Counts failed saves, so every failure can show the notice again after it was cleared.
const [failedSaves, setFailedSaves] = createSignal(0)
export { failedSaves }

export function loadSettings(path = configPath("settings.json")): LoadedSettings {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, problem: null }
  }
  const json = parseJson(text.replace(/^\uFEFF/, ""))
  const parsed = json.ok ? Stored.safeParse(json.value) : null
  if (!parsed?.success)
    return {
      settings: { ...DEFAULT_SETTINGS },
      problem: "settings.json is not valid JSON, using defaults",
    }
  const stored = parsed.data
  const settings = { ...DEFAULT_SETTINGS }
  const invalid: string[] = []
  function read<K extends keyof StoredSettings>(key: K, schema: z.ZodType<StoredSettings[K]>) {
    if (!(key in stored)) return
    const field = schema.safeParse(stored[key])
    if (field.success) settings[key] = field.data
    else invalid.push(key)
  }
  read("theme", Theme)
  read("sidebar", Sidebar)
  read("thinking", Thinking)
  read("sessionTitle", SessionTitle)
  read("permissionMode", Permission)
  read("editor", EditorSchema)
  read("notifications", Notifications)
  return {
    settings,
    problem: invalid.length > 0 ? `settings.json: invalid ${invalid.join(", ")}, using the default` : null,
  }
}

export function saveSettings(settings: StoredSettings, path = configPath("settings.json")): void {
  const { theme, sidebar, thinking, sessionTitle, permissionMode, editor, notifications } = settings
  try {
    mkdirSync(dirname(path), { recursive: true })
    const stored = { theme, sidebar, thinking, sessionTitle, permissionMode, editor, notifications }
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`)
  } catch (error) {
    log.warn("cannot save the settings", error)
    setFailedSaves((count) => count + 1)
  }
}
