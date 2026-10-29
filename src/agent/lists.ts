import type { EffortId, ModeId, ModelRef } from "./ids.ts"

export type CommandRow = {
  name: string
  description: string
  argumentHint: string
  aliases: string[]
  // The agent's own command, not a skill, prompt file or plugin command.
  builtin: boolean
  // The /settings row the command opens when typed bare.
  setting: string | null
}

export type EffortRow = { id: EffortId; label: string }

export type ModelRow = {
  ref: ModelRef
  label: string
  note: string
  // The full id an alias row stands for; null when the row is no alias.
  resolves: string | null
  // The model's own levels, lowest first; empty hides the effort control.
  efforts: EffortRow[]
  // The model takes images (with caps.images).
  images: boolean
}

// A heading in /model. A group of another provider than the session's may apply in a new session only.
export type ModelGroup = {
  provider: { id: string; name: string } | null
  applies: "now" | "new-session"
  models: ModelRow[]
}

// What YellowCode styles a mode as: plan gets the plan band, bypass the warning colors.
export type ModeKind = "default" | "edits" | "plan" | "auto" | "bypass" | "readonly" | "other"

export type ModeRow = {
  id: ModeId
  label: string
  description: string
  kind: ModeKind
  // Shift+Tab steps through the modes that cycle, in list order.
  cycle: boolean
  // False for one the session cannot switch to now.
  available: boolean
  // One mode is current per group, and the groups combine, as a collaboration mode and an approval preset do. null is
  // the main group, the one SessionInfo.mode names.
  group: string | null
}

export type SkillRow = {
  id: string
  name: string
  label: string
  description: string
  // What the prompt types to run it, without the slash; null when it has no command.
  command: string | null
  group: "builtin" | "global" | "project" | "account"
  plugin: string | null
  enabled: boolean
  // A policy or a plugin holds it; it cannot be toggled.
  locked: boolean
}

export type McpState = "connected" | "connecting" | "failed" | "needs-login" | "off" | "unknown"

// Only what is safe to show: env, headers and full arguments can hold credentials.
export type McpConfig = { command: string; package: string | null } | { url: string }

// Where a server is set up. `account`: it comes with the user's account (feature accountConnectors).
export type McpPlace = "project-shared" | "project-private" | "everywhere" | "account" | "builtin" | "managed" | "other"

// `status` and `origin` are the agent's own words, kept for display; the UI branches on `state` and `place`.
export type McpServerRow = {
  name: string
  // The short name the dialog shows.
  label: string
  place: McpPlace
  state: McpState
  status: string
  origin: string | null
  scope: string | null
  error: string | null
  config: McpConfig | null
  server: { name: string; version: string } | null
  // Null when the row does not list them; SessionInfo.tools names each tool's server.
  tools: string[] | null
}

// A plugin a running session loaded.
export type LoadedPlugin = { name: string; path: string; source: string | null }

// A row of the plugins dialog.
export type PluginRow = {
  id: string
  name: string
  marketplace: string | null
  scope: "global" | "project"
  on: boolean
  brings: { skills: string[]; mcp: string[]; commands: string[]; agents: string[]; hooks: string[] }
}

export type SubagentRow = { name: string; description: string }

export type HookRow = { event: string; matcher: string; plugin: string | null }

export type RuleRow = {
  id: string
  // The tool or action it covers, in the agent's words.
  subject: string
  pattern: string | null
  effect: "allow" | "ask" | "deny"
  lasts: "session" | "project" | "everywhere"
  // Where it is kept: a settings file, "project".
  origin: string | null
  // A rule that holds only in one mode.
  mode: ModeId | null
  removable: boolean
}

// Lists change on their own, so they are pushed; `refresh(list)` asks for one again.
export type Lists = {
  commands: CommandRow[]
  models: ModelGroup[]
  modes: ModeRow[]
  skills: SkillRow[]
  // The servers as the session has them now; they win over the ones in SessionInfo.
  mcp: McpServerRow[]
  // The plugins the session has loaded now; null: as SessionInfo says.
  loaded: LoadedPlugin[] | null
  plugins: PluginRow[]
  subagents: SubagentRow[]
  hooks: HookRow[]
  rules: RuleRow[]
}

export type ListName = keyof Lists
