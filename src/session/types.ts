import type { PermissionUpdate } from "../protocol/messages.ts"

export type ItemId = string

export type UserImage = { mediaType: string; data: string }
export type UserMessage = { kind: "user"; id: ItemId; text: string; images: UserImage[] }
export type AssistantText = { kind: "text"; id: ItemId; markdown: string; streaming: boolean }
export type Thinking = { kind: "thinking"; id: ItemId; text: string; streaming: boolean }
export type ToolCall = {
  kind: "tool"
  id: ItemId
  name: string
  inputText: string
  input: unknown
  summary: string
  status: "running" | "done" | "error" | "stopped"
  result: string
  children: ItemId[]
  patch: Hunk[] | null
  createdFile: boolean
  unchanged: boolean
  agent: Agent | null
  taskId: string | null
}
export type Agent = {
  name: string
  task: string
  state: TaskState
  toolUses: number
  durationMs: number
  report: string
  error: string | null
  // What the running agent is doing now, from its latest task_progress.
  activity: string
}
export type TaskState = "running" | "completed" | "failed" | "stopped"
// A background or foreground unit of work Claude reports with task_* messages: a subagent, a shell, a workflow.
export type Task = {
  id: string
  type: string
  toolUseId: string | null
  parentId: string | null
  depth: number
  background: boolean
  state: TaskState
  name: string
  description: string
  activity: string
  lastTool: string | null
  toolUses: number
  durationMs: number
  tokens: number
  summary: string
  outputFile: string | null
  error: string | null
  workflow: WorkflowProgress | null
}
export type WorkflowProgress = {
  phases: { index: number; title: string }[]
  agents: {
    index: number
    label: string
    phaseIndex: number | null
    state: string
    model: string | null
    toolCalls: number
    durationMs: number
    lastTool: string | null
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
  displayName: string
  input: unknown
  description: string
  reason: string
  suggestion: PermissionUpdate | null
  defaultToNo: boolean
  safetyCheck: boolean
  status: "pending" | "allowed" | "denied" | "answered"
  answers: Record<string, string>
  notes: Record<string, string>
  denial: string
}
export type TurnEnd = {
  kind: "turn-end"
  id: ItemId
  costUsd: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  error: string | null
  interrupted: boolean
  endedAt: number
}
export type SystemEvent = { kind: "system"; id: ItemId; text: string; level: "info" | "warning" }

export type Item = UserMessage | AssistantText | Thinking | ToolCall | Ask | TurnEnd | SystemEvent

export type SessionInfo = {
  id: string
  model: string
  permissionMode: string
  cwd: string
  cliVersion: string
  tools: string[]
  mcpServers: { name: string; status: string; error: string | null }[]
  skills: string[]
  apiKeySource: string
}

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

export type SessionStatus = "idle" | "running" | "ended"

export type Session = {
  info: SessionInfo | null
  status: SessionStatus
  items: ItemId[]
  byId: Record<ItemId, Item>
  tasks: Record<string, Task>
  usage: Usage
}
