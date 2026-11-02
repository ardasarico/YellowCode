import type { Ask as AgentAsk, AskOption, AskOutcome, Denial, Questions } from "../agent/ask.ts"
import type { AgentEvent, TaskKind } from "../agent/events.ts"
import type { EffortId, ModeId, ModelRef } from "../agent/ids.ts"
import type { ModelGroup, ModeRow } from "../agent/lists.ts"
import type { FileChange, Todo, ToolKind } from "../agent/tools.ts"
import type { PeerFrom } from "../peers/envelope.ts"
import type { Rewound } from "./rewind.ts"

export type ItemId = string

export type ChatImage = { name: string; mediaType: string; data: string | null; path: string | null }
// `queue` is "queued" from a send during a turn until the agent takes the message in, and "not sent" when the
// agent ended before that. `uuid` is the one the message went out with, or its transcript entry's.
export type UserMessage = {
  kind: "user"
  id: ItemId
  text: string
  images: ChatImage[]
  // The background agent a message was written to; `text` is then the message itself.
  to: { id: string; name: string } | null
  // Set once the message was passed on to that agent.
  delivery?: "sent" | "resumed"
  // Another YellowCode session sent it; `text` is then the message itself.
  from?: PeerFrom & { broadcast: boolean }
  queue: "queued" | "not sent" | null
  uuid?: string
}
// `local` marks the agent's own output for a local command (/context, /model), which belongs to no model turn.
// `quiet` marks what the main model does to pass a message on to an agent; the chat leaves it out.
export type AssistantText = {
  kind: "text"
  id: ItemId
  markdown: string
  streaming: boolean
  local?: boolean
  quiet?: boolean
}
// `durationMs` is null when the block did not stream, as in a resumed session.
export type Thinking = { kind: "thinking"; id: ItemId; text: string; streaming: boolean; durationMs: number | null }
// `name` is the agent's own, kept for mods and the export; rows show `title` and the UI goes by `toolKind`.
export type ToolCall = {
  kind: "tool"
  id: ItemId
  name: string
  toolKind: ToolKind
  // The name the row shows, and the MCP server of an MCP tool.
  title: string
  server: string | null
  inputText: string
  input: unknown
  summary: string
  // What the call says it does, shown while it runs.
  detail: string | null
  // It was asked to run in the background.
  background: boolean
  status: "running" | "done" | "error" | "stopped"
  result: string
  children: ItemId[]
  patch: Hunk[] | null
  createdFile: boolean
  // The text of a file the call made.
  content: string | null
  images: ChatImage[]
  unchanged: boolean
  // What a read or a search came back with.
  count: Extract<AgentEvent, { type: "tool.end" }>["count"]
  // Files a finished call wrote; what they held before goes to the rewind's listener, not into the store.
  files: Omit<FileChange, "before">[]
  // A question call's pages, so the row can show their headers.
  questions: Questions | null
  // How a question call ended, read from its result; null for other calls, a failed call, and one stopped without a
  // result.
  outcome: AskOutcome | null
  agent: Agent | null
  taskId: string | null
  quiet?: boolean
  // A `!` command YellowCode ran itself; told once it went out with a message the agent reads.
  local?: { told: boolean }
}
export type Agent = {
  name: string
  task: string
  prompt: string
  type: string
  // "" until the Agent input or the subagent's first message names it.
  model: string
  tokens: number
  state: TaskState
  toolUses: number
  durationMs: number
  report: string
  error: string | null
  // What the running agent is doing now, from its latest task_progress.
  activity: string
  // The user stopped it (x or an interrupt). claude will not resume it; codex and opencode may, which clears this.
  stoppedByUser: boolean
}
export type TaskState = "running" | "completed" | "failed" | "stopped"
// A background or foreground unit of work the agent reports: a subagent, a shell, a workflow.
export type Task = {
  id: string
  type: string
  kind: TaskKind
  toolUseId: string | null
  parentId: string | null
  depth: number
  background: boolean
  state: TaskState
  name: string
  description: string
  prompt: string
  workflowName: string
  startedAt: number | null
  activity: string
  lastTool: string | null
  toolUses: number
  durationMs: number
  tokens: number
  summary: string
  outputFile: string | null
  exitCode: number | null
  error: string | null
  workflow: WorkflowProgress | null
  // The Bash command of a shell; "" for other tasks.
  command: string
  // Epoch milliseconds, shifted like every other replayed time.
  endedAt: number | null
  // The latest tail of its output; null until the agent sends one.
  output: string | null
  outputBytes: number
  truncated: boolean
}
export type WorkflowProgress = {
  phases: { index: number; title: string }[]
  agents: {
    index: number
    label: string
    phaseIndex: number | null
    phaseTitle: string | null
    state: string
    prompt: string
    model: string | null
    toolCalls: number
    tokens: number
    durationMs: number
    // Epoch milliseconds, shifted like every other replayed time.
    startedAt: number | null
    lastTool: string | null
    lastToolSummary: string | null
    result: string | null
  }[]
}
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export type Ask = {
  kind: "ask"
  id: ItemId
  requestId: string
  toolUseId: string
  toolName: string
  toolKind: ToolKind
  server: string | null
  displayName: string
  input: unknown
  // The band's main line: a command, a path, a URL.
  target: string
  // Absolute paths the call will write.
  writes: string[]
  // The change the call will make, when the agent sent it with the ask.
  diff?: { path: string; hunks: Hunk[] }[]
  description: string
  reason: string
  // In the agent's order; a question with pages or a matrix has none.
  options: AskOption[]
  questions: Questions | null
  plan: AgentAsk["plan"]
  defaultToNo: boolean
  safetyCheck: boolean
  status: "pending" | "allowed" | "denied" | "answered" | "cancelled"
  answers: Record<string, string>
  notes: Record<string, string>
  // A no: the text it reached the agent with, why (always set once denied), and the user's note.
  denial: string
  why: Denial | null
  note: string
  // The subagent that asked; absent for the main thread.
  agent?: string
  // Set for a call to our own ask tool, which is answered with an MCP result under this JSON-RPC id.
  mcp?: { rpcId: string | number }
  // A finished plan the agent reported without asking: YellowCode answers it, and "Yes, start" goes on in `next`.
  ownPlan?: { next: ModeId | null }
}
export type TurnEnd = {
  kind: "turn-end"
  id: ItemId
  costUsd: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  error: string | null
  // The attempt count of the API retries before a failed turn gave up; 0 when none ran.
  retries: number
  interrupted: boolean
  endedAt: number
}
// `at` is epoch milliseconds, shifted like every other replayed time.
// `max` is null when the agent does not say how many tries it makes.
export type Retry = {
  attempt: number
  max: number | null
  delayMs: number
  status: number | null
  reason: string
  at: number
}
export type SystemEvent = {
  kind: "system"
  id: ItemId
  text: string
  level: "info" | "warning" | "error"
  retry?: Retry
  detail?: string[]
  // A compaction's context size before and after.
  tokens?: { before: number; after: number | undefined }
}
// Why the agent went away, for the row that ends the chat; `detail` is the tail of its stderr, if any.
export type SessionEnd = { text: string; detail: string[] }
export type ShellEnd = { kind: "shell-end"; id: ItemId; taskId: string }

export type Item = UserMessage | AssistantText | Thinking | ToolCall | Ask | TurnEnd | SystemEvent | ShellEnd

export type SessionInfo = {
  id: string
  model: string
  permissionMode: string
  cwd: string
  cliVersion: string
  tools: string[]
  mcpServers: McpServer[]
  skills: string[]
  slashCommands: string[]
  agents: string[]
  plugins: { name: string; path: string; source: string | null }[]
  apiKeySource: string
}

// Init carries only name, status and source; the rest stays null until a live mcp_status reply fills it in.
export type McpServer = {
  name: string
  status: string
  // A config scope (project, local, user, managed, …), plugin, claudeai, dynamic or sdk.
  source: string | null
  scope: string | null
  error: string | null
  config: McpConfig | null
  serverInfo: { name: string; version: string } | null
  tools: string[] | null
}

// Only what is safe to show: env, headers and full arguments can hold credentials.
export type McpConfig = { command: string; package: string | null } | { url: string }

// Times are epoch milliseconds; in replay they are shifted so recorded resets lie in the future.
export type Window = { utilization: number; resetsAt: number }

export type Usage = {
  startedAt: number | null
  tokens: number
  costUsd: number
  context: { used: number; window: number | null }
  limits: { fiveHour: Window | null; week: Window | null; models: Record<string, Window> }
  warning: { status: string; type: string; resetsAt: number } | null
}

// "starting" lasts until the agent is ready or the first message goes out.
export type SessionStatus = "starting" | "idle" | "running" | "ended"

export type Session = {
  info: SessionInfo | null
  status: SessionStatus
  items: ItemId[]
  byId: Record<ItemId, Item>
  tasks: Record<string, Task>
  // What Claude reported after the last init (mcp_status, reload_plugins), live only; it wins over info's lists.
  mcpServers: McpServer[] | null
  plugins: SessionInfo["plugins"] | null
  usage: Usage
  rewound: Rewound | null
  // An interrupt went out and its turn has not ended yet.
  interrupting: boolean
  // The turn the agent is working on, from its start to its result, and who started it: a user message, or the
  // agent itself (a background task's end). The status can stay "running" without one while messages wait to be
  // taken in.
  turn: "user" | "agent" | null
  // The permission mode the agent says the session runs in (Claude's "default" is shown as manual).
  permissionMode: string | null
  // The modes an agent that lists its own said it has; absent until it does.
  modes?: ModeRow[]
  // The same for models, and the model and effort such an agent says the session runs.
  models?: ModelGroup[]
  model?: ModelRef | null
  effort?: EffortId | null
  // The working plan an agent tells as steps outside any tool call; absent until it does.
  todos?: Todo[]
  // The title the agent keeps for the session: the last rename, YellowCode's own or a typed /rename.
  agentTitle: string | null
  // How many times the agent started the conversation over (/clear).
  conversation: number
  // The agent is summarizing the conversation (/compact, or on its own when the context is full).
  compacting: boolean
  // Agent and workflow calls from before a /clear whose task still ran then: off the chat, still in the agent panel.
  carried: ItemId[]
  // The session itself is gone, so it cannot restart; absent otherwise.
  final?: true
}
