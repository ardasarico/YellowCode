import type { AskReply } from "./ask.ts"
import type { Capabilities } from "./capabilities.ts"
import type { AgentEvent } from "./events.ts"
import type { AgentKindId, AskId, EffortId, ModeId, ModelRef, Outcome, PromptId, TaskId } from "./ids.ts"
import type { ListName, ModelGroup } from "./lists.ts"
import type { SettingChange, SettingRow, SettingValue } from "./settings.ts"
import type { FileBackup, HistoryCursor, HistoryPage, SessionEntry, SessionRef } from "./sessions.ts"

export type PromptImage = { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; base64: string }

export type Prompt = {
  id: PromptId
  text: string
  images: PromptImage[]
  // Set when the text runs one of the agent's commands.
  command: { name: string; args: string } | null
  // A message for a running subagent (feature agentMessages).
  to: { task: TaskId; name: string } | null
  // Only matters while a turn runs.
  delivery: "steer" | "queue"
  // What the agent said while the conversation was cut; it hears it again ahead of the text.
  kept: string[]
  // The conversation of another agent's session this one replaced; the agent reads it ahead of the text, the chat does
  // not show it.
  context: string | null
  // `!` commands the user ran since the last prompt; the agent reads them after the text, the chat does not show them.
  shells: { command: string; output: string }[]
}

// A tool YellowCode serves to the agent, such as a mod's. `server` groups one mod's tools under one name. A hint
// left out is left to the agent; `annotations` null gives none.
export type ClientTool = {
  server: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnly?: boolean; destructive?: boolean; title?: string } | null
  // Never rejects: a failure is an error result.
  run(input: Record<string, unknown>): Promise<{ text: string; error: boolean }>
}

export type McpLaunch =
  | { name: string; command: string; args: string[]; env: Record<string, string> }
  | { name: string; url: string; headers: Record<string, string> }

export type StartOptions = {
  cwd: string
  // `fork` opens a copy ("Open a copy here"); `at` starts the copy before that prompt.
  resume: { ref: SessionRef; fork: boolean; at: PromptId | null } | null
  mode: ModeId | null
  // The user's saved mode; a session that starts in another mode can still switch to it.
  defaultMode: ModeId | null
  model: ModelRef | null
  effort: EffortId | null
  extraEffort: boolean
  thinking: boolean
  // Added to the agent's own instructions (caps.instructions).
  instructions: string[]
  clientTools: ClientTool[]
  mcpServers: McpLaunch[]
  // The agent keeps nothing of the session once it is closed, and its own lists never show it.
  ephemeral: boolean
  // Without the user's plugins, hooks and MCP servers, as far as the agent has a switch for it.
  plain: boolean
  // Asks before every edit and shell command, whatever the mode allows. Only a launcher with `asking` gets it.
  asks?: boolean
}

// The app's saved settings of the moment, for a session that goes on in a new agent process. `mode` null: it goes on
// in the mode it was in.
export type RestartOptions = Pick<StartOptions, "mode" | "defaultMode" | "thinking">

export type Detection =
  | { installed: false }
  // `blocked` names a protocol YellowCode cannot speak, such as "needs opencode 2".
  | { installed: true; version: string; blocked: string | null; signedIn: boolean | null }

export type ContextReport = {
  model: string
  used: number
  window: number
  // Empty when caps.context is "total". `holds`: the category opens to `files` or `tools`.
  categories: {
    id: string
    name: string
    tokens: number
    kind: "used" | "free" | "other"
    holds: "files" | "tools" | null
  }[]
  files: { path: string; tokens: number }[]
  // `name` is the tool's own, without its server's.
  tools: { name: string; server: string; tokens: number }[]
}

export type UsageReport = {
  costUsd: number | null
  apiMs: number | null
  wallMs: number | null
  linesAdded: number | null
  linesRemoved: number | null
  models: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }[]
  plan: string | null
}

// One installed agent. Session-level entry points live here, not on a running agent.
export type AgentKind = {
  id: AgentKindId
  name: string
  // What the chat calls it in short texts ("tell Claude instead"); `name` when not given.
  shortName?: string
  // What its sessions can do; a saved session is shown with these.
  caps: Capabilities
  detect(): Promise<Detection>
  start(options: StartOptions): Promise<Agent>
  // Every session of this agent for the folder, newest first.
  sessions(cwd: string): Promise<SessionEntry[]>
  // An earlier session's events, the latest page first; null starts from the end. Refs here and in `heldElsewhere`
  // and `fileHistory` come from `sessions()`.
  history(ref: SessionRef, cursor: HistoryCursor | null): Promise<HistoryPage>
  heldElsewhere?(ref: SessionRef): Promise<boolean>
  // One answer from the agent's model, outside the session, for YellowCode's own titles.
  oneShot?(prompt: string, cwd: string): Promise<string | null>
  // The models list from a short-lived process that keeps no session, for the catalog.
  listModels?(cwd: string): Promise<ModelGroup[]>
  // The agent's own file backups of a session (feature fileHistory), for the prompts `wanted` says yes to.
  fileHistory?(ref: SessionRef, wanted: (prompt: PromptId) => boolean): Promise<FileBackup[]>
  // For an agent whose settings writes go out as messages: the change a message's text makes, or null for any other
  // message.
  settingChange?(text: string): SettingChange | null
  // For the same agents: the message that writes a setting, which YellowCode sends as the user's own in place of
  // `settings.write`; null for a setting the agent does not have.
  settingMessage?(id: string, value: SettingValue): string | null
  // A recording of this agent's own wire, played back as a session. `send` and `answer` release the next recorded
  // message or reply; other intents do nothing.
  replay?(path: string): Promise<Agent>
}

// A running session. Each intent the agent takes shows up as events too, so the store learns of it one way.
export type Agent = {
  readonly kind: AgentKindId
  // Known once `start` resolves, before the agent reports it.
  readonly session: SessionRef
  readonly version: string
  readonly caps: Capabilities
  // Already ordered; ends when the agent is closed.
  readonly events: AsyncIterable<AgentEvent>
  // A pending cut goes first. Not ok: the prompt did not go out, and the user's text goes back to the input.
  send(prompt: Prompt): Promise<Outcome>
  interrupt(): Promise<Outcome>
  // Takes back a prompt still waiting behind the turn; false once the agent has taken it in.
  withdraw?(prompt: PromptId): Promise<boolean>
  answer(ask: AskId, reply: AskReply): Promise<void>
  // After `ended`: the same session goes on in a new agent process, with the settings it had and the saved ones in
  // `options`.
  restart(options: RestartOptions): Promise<Outcome>
  close(): Promise<void>
  setMode(mode: ModeId): Promise<Outcome>
  setModel(model: ModelRef): Promise<Outcome>
  setEffort(effort: EffortId | null): Promise<Outcome>
  setExtraEffort(on: boolean): Promise<Outcome>
  setThinking(shown: boolean): Promise<Outcome>
  rename(title: string): Promise<Outcome>
  // The conversation goes back to before the prompt with the next send; `undoCut` takes it back until then.
  cut(before: PromptId): Promise<Outcome>
  undoCut(): Promise<Outcome>
  // Asks for a list again; it comes back as a `lists` event.
  refresh(list: ListName): void
  tasks: {
    stop(id: TaskId): Promise<Outcome>
    background(): Promise<Outcome>
  }
  mcp: {
    toggle(name: string, on: boolean): Promise<Outcome>
    reconnect(name: string): Promise<Outcome>
    login(name: string): Promise<Outcome>
  }
  skills: { toggle(id: string, on: boolean): Promise<Outcome>; reload(): Promise<Outcome> }
  plugins: { toggle(id: string, on: boolean): Promise<Outcome>; reload(): Promise<Outcome> }
  permissions: { remove(id: string): Promise<Outcome> }
  settings: { rows(): Promise<SettingRow[]>; write(id: string, value: SettingValue): Promise<Outcome> }
  context(): Promise<ContextReport>
  usage(): Promise<UsageReport>
  files(query: string): Promise<string[]>
  // For caps.clientTools and caps.mcpServers "live".
  setClientTools(tools: ClientTool[]): Promise<Outcome>
  setMcpServers(servers: McpLaunch[]): Promise<Outcome>
  // Only on a replay.
  replayStatus?(): "playing" | "waiting" | "finished"
}
