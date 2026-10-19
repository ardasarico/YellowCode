import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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

export type LoadedSettings = {
  settings: StoredSettings
  problem: string | null
  backup: string | null
}

export const SAVE_PROBLEM = "cannot save settings.json, changes last until you quit"
// Counts failed saves, so every failure can show the notice again after it was cleared.
const [failedSaves, setFailedSaves] = createSignal(0)
export { failedSaves }

function asStored(value: unknown): Record<string, unknown> | null {
  const parsed = Stored.safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseJsonc(text: string): unknown {
  try {
    return Bun.JSONC.parse(text)
  } catch {
    return null
  }
}

function salvage(text: string): Record<string, unknown> {
  const stored: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`).exec(text)
    if (match) stored[key] = match[1]
  }
  return stored
}

function readStored(stored: Record<string, unknown>) {
  const found: Partial<StoredSettings> = {}
  const invalid: string[] = []
  function read<K extends keyof StoredSettings>(key: K, schema: z.ZodType<StoredSettings[K]>) {
    if (!(key in stored)) return
    const field = schema.safeParse(stored[key])
    if (field.success) found[key] = field.data
    else invalid.push(key)
  }
  read("theme", Theme)
  read("sidebar", Sidebar)
  read("thinking", Thinking)
  read("sessionTitle", SessionTitle)
  read("permissionMode", Permission)
  read("editor", EditorSchema)
  read("notifications", Notifications)
  return { settings: { ...DEFAULT_SETTINGS, ...found }, found, invalid }
}

export function loadSettings(path = configPath("settings.json")): LoadedSettings {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, problem: null, backup: null }
  }
  text = text.replace(/^\uFEFF/, "")
  const parsed = parseJson(text)
  const json = parsed.ok ? asStored(parsed.value) : null
  if (json) {
    const { settings, invalid } = readStored(json)
    const problem = invalid.length > 0 ? `settings.json: invalid ${invalid.join(", ")}, using the default` : null
    return { settings, problem, backup: null }
  }
  const { settings, found } = readStored(asStored(parseJsonc(text)) ?? salvage(text))
  const backup = `${path}.bak`
  let fixed = false
  try {
    copyFileSync(path, backup)
    fixed = saveSettings(found, path)
  } catch (error) {
    log.warn("cannot archive the settings", error)
  }
  return fixed
    ? { settings, problem: "settings.json repaired", backup }
    : { settings, problem: "settings.json is broken, cannot repair it", backup: null }
}

export function saveSettings(settings: Partial<StoredSettings>, path = configPath("settings.json")): boolean {
  const { theme, sidebar, thinking, sessionTitle, permissionMode, editor, notifications } = settings
  try {
    mkdirSync(dirname(path), { recursive: true })
    const stored = { theme, sidebar, thinking, sessionTitle, permissionMode, editor, notifications }
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`)
    return true
  } catch (error) {
    log.warn("cannot save the settings", error)
    setFailedSaves((count) => count + 1)
    return false
  }
}
