import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { createSignal } from "solid-js"
import { z } from "zod"
import type { AgentKindId, ModeId } from "../agent/ids.ts"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { parseJson } from "../json.ts"
import { themes } from "../theme/theme.ts"

export type SidebarSetting = "auto" | "shown" | "hidden"
export type ThinkingSetting = "summarized" | "hidden"
export type TitleSource = "yellowcode" | "claude-code"
export const EDITORS = ["default", "zed", "vscode", "cursor"] as const
export type Editor = (typeof EDITORS)[number]
export const NOTIFICATIONS = ["all", "waiting", "off"] as const
export type NotificationSetting = (typeof NOTIFICATIONS)[number]

// What YellowCode keeps for one agent, under the agent's id.
export type AgentPrefs = { defaultMode?: ModeId }

export type StoredSettings = {
  theme: string
  sidebar: SidebarSetting
  thinking: ThinkingSetting
  sessionTitle: TitleSource
  editor: Editor
  notifications: NotificationSetting
  disabledMods: string[]
  // Unset until the user picks one; a start then opens the first installed agent.
  defaultAgent?: AgentKindId
  agents: Record<AgentKindId, AgentPrefs>
}

export const DEFAULT_SETTINGS: StoredSettings = {
  theme: "default-dark",
  sidebar: "auto",
  thinking: "summarized",
  sessionTitle: "yellowcode",
  editor: "default",
  notifications: "all",
  disabledMods: [],
  // Present, so the file keeps it once it is picked; an unset one is not written.
  defaultAgent: undefined,
  agents: {},
}

// Claude's mode when none is saved for it.
export const DEFAULT_MODE: ModeId = "auto"

// The agent a start opens: the saved one when it runs here, else the first of `agents` that does. The last one left is
// not asked, since nothing else could open; with nothing saved and one agent, nothing is asked.
export async function pickAgent(
  saved: AgentKindId | undefined,
  agents: AgentKindId[],
  runs: (agent: AgentKindId) => Promise<boolean>,
): Promise<AgentKindId | undefined> {
  const order =
    saved !== undefined && agents.includes(saved) ? [saved, ...agents.filter((agent) => agent !== saved)] : agents
  // One at a time: the first that runs wins, and the ones after it are never asked.
  // oxlint-disable-next-line no-await-in-loop
  for (const agent of order.slice(0, -1)) if (await runs(agent)) return agent
  return order.at(-1)
}

// The mode the user saved for the agent's new sessions; null leaves it to the agent.
export function defaultModeIn(settings: StoredSettings, agent: AgentKindId): ModeId | null {
  return settings.agents[agent]?.defaultMode ?? null
}

// What the agent's new sessions start in: the saved mode, else Claude's own for Claude, else the agent's default (null).
export const startModeIn = (settings: StoredSettings, agent: AgentKindId): ModeId | null =>
  defaultModeIn(settings, agent) ?? (agent === CLAUDE_ENTRY ? DEFAULT_MODE : null)

// Files written before agents had their own entries keep Claude's saved mode at the top; read as Claude's entry until
// those files are gone. Until each agent says its own modes, only Claude's entry is checked against mode names.
const LEGACY_MODE = "permissionMode"
const CLAUDE_ENTRY = "claude"

const Stored = z.record(z.string(), z.unknown())

const Theme = z.string().refine((id) => themes().some((theme) => theme.id === id))
const Sidebar = z.enum(["auto", "shown", "hidden"])
const Thinking = z.enum(["summarized", "hidden"])
const SessionTitle = z.enum(["yellowcode", "claude-code"])
// Claude's modes by its own ids; earlier files saved "default" under the name the user sees, "manual".
const CLAUDE_MODE_IDS = ["auto", "default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const
const Permission = z.preprocess((mode) => (mode === "manual" ? "default" : mode), z.enum(CLAUDE_MODE_IDS))
const EditorSchema = z.enum(EDITORS)
const Notifications = z.enum(NOTIFICATIONS)
const DisabledMods = z.array(z.string())
const DefaultAgent = z.string()
const AgentEntry = z.object({ defaultMode: z.string().optional() })
const ClaudeEntry = z.object({ defaultMode: Permission.optional() })

export type LoadedSettings = {
  settings: StoredSettings
  problem: string | null
  backup: string | null
}

export const SAVE_PROBLEM = "cannot save settings.json, changes last until you quit"
export const UNREADABLE_PROBLEM = "cannot read settings.json, changes last until you quit"
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
  for (const key of [...Object.keys(DEFAULT_SETTINGS), LEGACY_MODE]) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`).exec(text)
    if (match) stored[key] = match[1]
  }
  // An agent's entry as saveSettings writes it.
  const agents: Record<string, unknown> = {}
  for (const [, agent = "", mode] of text.matchAll(/"([^"\\]+)"\s*:\s*\{\s*"defaultMode"\s*:\s*"([^"\\]*)"/g))
    agents[agent] = { defaultMode: mode }
  if (Object.keys(agents).length > 0) stored["agents"] = agents
  return stored
}

// Each agent's entry stands alone, so a bad one leaves the others.
function readAgents(stored: Record<string, unknown>, invalid: string[]): StoredSettings["agents"] | undefined {
  let agents: StoredSettings["agents"] | undefined
  if ("agents" in stored) {
    const entries = Stored.safeParse(stored["agents"])
    if (entries.success) {
      agents = {}
      for (const [agent, entry] of Object.entries(entries.data)) {
        const parsed = (agent === CLAUDE_ENTRY ? ClaudeEntry : AgentEntry).safeParse(entry)
        if (parsed.success) agents[agent] = parsed.data
        else invalid.push(`agents.${agent}`)
      }
    } else invalid.push("agents")
  }
  const claude = agents?.[CLAUDE_ENTRY]
  if (!(LEGACY_MODE in stored) || claude?.defaultMode !== undefined) return agents
  const mode = Permission.safeParse(stored[LEGACY_MODE])
  if (mode.success) return { ...agents, [CLAUDE_ENTRY]: { ...claude, defaultMode: mode.data } }
  invalid.push(LEGACY_MODE)
  return agents
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
  const agents = readAgents(stored, invalid)
  if (agents) found.agents = agents
  read("editor", EditorSchema)
  read("notifications", Notifications)
  read("disabledMods", DisabledMods)
  read("defaultAgent", DefaultAgent)
  return { settings: { ...DEFAULT_SETTINGS, ...found }, found, invalid }
}

// Files that exist but could not be read: saving would replace what the user still has there.
const unreadable = new Set<string>()

export function loadSettings(path = configPath("settings.json")): LoadedSettings {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { settings: { ...DEFAULT_SETTINGS }, problem: null, backup: null }
    log.warn("cannot read the settings", error)
    unreadable.add(path)
    return { settings: { ...DEFAULT_SETTINGS }, problem: UNREADABLE_PROBLEM, backup: null }
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
    // The first backup holds the user's own bytes; a later repair would only copy over them.
    if (!existsSync(backup)) copyFileSync(path, backup)
    fixed = saveSettings(found, path)
  } catch (error) {
    log.warn("cannot archive the settings", error)
  }
  return fixed
    ? { settings, problem: "settings.json repaired", backup }
    : { settings, problem: "settings.json is broken, cannot repair it", backup: null }
}

export function saveSettings(settings: Partial<StoredSettings>, path = configPath("settings.json")): boolean {
  if (unreadable.has(path)) {
    setFailedSaves((count) => count + 1)
    return false
  }
  // Written beside the file and renamed over it, so a failed write leaves the old one whole; a symlinked file keeps
  // its link.
  let target = path
  try {
    target = realpathSync(path)
  } catch {
    // Not there yet.
  }
  const temp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    const stored = Object.fromEntries(Object.entries(settings).filter(([key]) => key in DEFAULT_SETTINGS))
    writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`)
    renameSync(temp, target)
    return true
  } catch (error) {
    rmSync(temp, { force: true })
    log.warn("cannot save the settings", error)
    setFailedSaves((count) => count + 1)
    return false
  }
}
