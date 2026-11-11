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
import type { AgentKindId, ModelRef, ModeId } from "../agent/ids.ts"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { parseJson } from "../json.ts"
import { themes } from "../theme/theme.ts"
import { type Channel, CHANNELS } from "../update/channels.ts"

export type SidebarSetting = "auto" | "shown" | "hidden"
export type ThinkingSetting = "summarized" | "hidden"
export type TitleSource = "yellowcode" | "agent"
export const EDITORS = ["default", "zed", "vscode", "cursor"] as const
export type Editor = (typeof EDITORS)[number]
export const NOTIFICATIONS = ["all", "waiting", "off"] as const
export type NotificationSetting = (typeof NOTIFICATIONS)[number]

// What YellowCode keeps for one agent, under the agent's id. `warned`: the agent's one-time warning was shown;
// `replacedTold`: the names whose notice about a shared server over the agent's own was shown; `untrustedTold`: the
// project folders whose notice that the agent leaves their files off was shown.
export type AgentPrefs = { defaultMode?: ModeId; warned?: boolean; replacedTold?: string[]; untrustedTold?: string[] }

// Models by modelKey: `favorites` are the ones Shift+←→ walks, `hidden` the ones /model leaves out.
export type ModelMarks = { favorites: string[]; hidden: string[] }

// A model as favorites and hidden marks keep it: the provider and the listed row it is picked by, which stays when the
// model behind an alias changes.
export const modelKey = (provider: AgentKindId, ref: ModelRef): string =>
  joinKey(provider, ref.provider === null ? ref.id : `${ref.provider}/${ref.id}`)

const joinKey = (provider: AgentKindId, model: string) => `${provider}:${model}`

export type StoredSettings = {
  theme: string
  sidebar: SidebarSetting
  thinking: ThinkingSetting
  // "fold": the tool rows of a turn that ended shrink to one line per run.
  finishedTurns: "fold" | "show"
  sessionTitle: TitleSource
  editor: Editor
  notifications: NotificationSetting
  disabledMods: string[]
  // Unset until the user picks one; updates then follow how YellowCode was installed (defaultChannel).
  updates?: Channel
  // Unset until the user picks them.
  providers?: AgentKindId[]
  models: ModelMarks
  // The model the last session used, which a start opens.
  lastModel?: { provider: AgentKindId; ref: ModelRef }
  // Read from files written before providers, for usedProviders only; never saved.
  defaultAgent?: AgentKindId
  agents: Record<AgentKindId, AgentPrefs>
  // How many subagents run at once; the others wait.
  maxSubagents: number
  // "off": the providers' own configured MCP servers stay out of YellowCode's sessions.
  ownMcpServers: "on" | "off"
}

export const DEFAULT_SETTINGS: StoredSettings = {
  theme: "default-dark",
  sidebar: "auto",
  thinking: "summarized",
  finishedTurns: "fold",
  sessionTitle: "yellowcode",
  editor: "default",
  notifications: "all",
  disabledMods: [],
  // Present, so the file keeps them once they are set; unset ones are not written.
  updates: undefined,
  providers: undefined,
  models: { favorites: [], hidden: [] },
  lastModel: undefined,
  agents: {},
  maxSubagents: 6,
  ownMcpServers: "on",
}

// The providers an older file shows were used: those with an entry and the default agent it saved, in `known` order.
export const usedProviders = (settings: StoredSettings, known: AgentKindId[]): AgentKindId[] =>
  known.filter((id) => id in settings.agents || id === settings.defaultAgent)

// Claude's mode when none is saved for it.
export const DEFAULT_MODE: ModeId = "auto"

// The order a start tries the agents in: the saved one first.
const agentOrder = (saved: AgentKindId | undefined, agents: AgentKindId[]): AgentKindId[] =>
  saved !== undefined && agents.includes(saved) ? [saved, ...agents.filter((agent) => agent !== saved)] : agents

// The agents a start tries when `failed` did not start: those after it in the order `pickAgent` uses.
export function fallbackAgents(saved: AgentKindId | undefined, agents: AgentKindId[], failed: AgentKindId) {
  const order = agentOrder(saved, agents)
  return order.slice(order.indexOf(failed) + 1)
}

// The agent a start opens: the saved one when it runs here, else the first of `agents` that does. The last one left is
// not asked, since nothing else could open; with nothing saved and one agent, nothing is asked.
export async function pickAgent(
  saved: AgentKindId | undefined,
  agents: AgentKindId[],
  runs: (agent: AgentKindId) => Promise<boolean>,
): Promise<AgentKindId | undefined> {
  const order = agentOrder(saved, agents)
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
const FinishedTurns = z.enum(["fold", "show"])
// Earlier files saved the agent's own titles as "claude-code".
const SessionTitle = z.preprocess(
  (source) => (source === "claude-code" ? "agent" : source),
  z.enum(["yellowcode", "agent"]),
)
// Claude's modes by its own ids; earlier files saved "default" under the name the user sees, "manual".
const CLAUDE_MODE_IDS = ["auto", "default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const
const Permission = z.preprocess((mode) => (mode === "manual" ? "default" : mode), z.enum(CLAUDE_MODE_IDS))
const EditorSchema = z.enum(EDITORS)
const Notifications = z.enum(NOTIFICATIONS)
const DisabledMods = z.array(z.string())
const Updates = z.enum(CHANNELS)
const DefaultAgent = z.string()
export const MAX_SUBAGENTS = 10
const MaxSubagents = z.number().int().min(1).max(MAX_SUBAGENTS)
const OwnMcpServers = z.enum(["on", "off"])
const Providers = z.array(z.string()).min(1)
const Keys = z.array(z.string()).default([])
const Models = z.object({ favorites: Keys, hidden: Keys })
const LastModel = z.object({
  provider: z.string(),
  ref: z.object({ provider: z.string().nullable(), id: z.string() }),
})
// Favorites were kept per agent, by the row's ref alone; they move to `models`.
const FavoriteModels = z.array(z.string()).optional()
const AgentEntry = z.object({
  defaultMode: z.string().optional(),
  favoriteModels: FavoriteModels,
  warned: z.boolean().optional(),
  replacedTold: z.array(z.string()).optional(),
  untrustedTold: z.array(z.string()).optional(),
})
const ClaudeEntry = z.object({
  defaultMode: Permission.optional(),
  favoriteModels: FavoriteModels,
  replacedTold: z.array(z.string()).optional(),
})

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

// The array or object right after `"key":`, when the file still has all of it.
function valueAt(text: string, key: string): unknown {
  const found = new RegExp(`"${key}"\\s*:\\s*(?=[[{])`).exec(text)
  if (!found) return undefined
  const start = found.index + found[0].length
  let depth = 0
  let quoted = false
  for (let at = start; at < text.length; at++) {
    const char = text[at]
    if (quoted) {
      if (char === "\\") at++
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === "[" || char === "{") depth++
    else if ((char === "]" || char === "}") && --depth === 0) return parseJsonc(text.slice(start, at + 1)) ?? undefined
  }
  return undefined
}

function salvage(text: string): Record<string, unknown> {
  const stored: Record<string, unknown> = {}
  for (const key of [...Object.keys(DEFAULT_SETTINGS), LEGACY_MODE, "defaultAgent"]) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`).exec(text)
    const value = match ? match[1] : valueAt(text, key)
    if (value !== undefined) stored[key] = value
  }
  if ("agents" in stored) return stored
  // An agent's entry as saveSettings writes it.
  const agents: Record<string, unknown> = {}
  for (const [, agent = "", mode] of text.matchAll(/"([^"\\]+)"\s*:\s*\{\s*"defaultMode"\s*:\s*"([^"\\]*)"/g))
    agents[agent] = { defaultMode: mode }
  if (Object.keys(agents).length > 0) stored["agents"] = agents
  return stored
}

// Each agent's entry stands alone, so a bad one leaves the others. Its old favorites go to `favorites`.
function readAgents(
  stored: Record<string, unknown>,
  invalid: string[],
  favorites: string[],
): StoredSettings["agents"] | undefined {
  let agents: StoredSettings["agents"] | undefined
  if ("agents" in stored) {
    const entries = Stored.safeParse(stored["agents"])
    if (entries.success) {
      agents = {}
      for (const [agent, entry] of Object.entries(entries.data)) {
        const parsed = (agent === CLAUDE_ENTRY ? ClaudeEntry : AgentEntry).safeParse(entry)
        if (!parsed.success) {
          invalid.push(`agents.${agent}`)
          continue
        }
        const { favoriteModels = [], ...prefs } = parsed.data
        favorites.push(...favoriteModels.map((model) => joinKey(agent, model)))
        agents[agent] = prefs
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
  read("finishedTurns", FinishedTurns)
  read("sessionTitle", SessionTitle)
  read("providers", Providers)
  read("models", Models)
  read("lastModel", LastModel)
  const moved: string[] = []
  const agents = readAgents(stored, invalid, moved)
  if (agents) found.agents = agents
  const models = found.models ?? DEFAULT_SETTINGS.models
  const favorites = moved.filter((key) => !models.favorites.includes(key))
  if (favorites.length > 0) found.models = { ...models, favorites: [...models.favorites, ...favorites] }
  read("editor", EditorSchema)
  read("notifications", Notifications)
  read("disabledMods", DisabledMods)
  read("updates", Updates)
  read("defaultAgent", DefaultAgent)
  read("maxSubagents", MaxSubagents)
  read("ownMcpServers", OwnMcpServers)
  return { settings: { ...DEFAULT_SETTINGS, ...found }, found, invalid }
}

// Files that exist but could not be read: saving would replace what the user still has there.
const unreadable = new Set<string>()

// `repair` false leaves a broken file as it is.
export function loadSettings(path = configPath("settings.json"), repair = true): LoadedSettings {
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
  if (!repair) return { settings, problem: "settings.json is broken", backup: null }
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
