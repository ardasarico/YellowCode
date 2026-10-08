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
  status: "running" | "done" | "error"
  result: string
  children: ItemId[]
  patch: Hunk[] | null
  createdFile: boolean
  agent: { name: string; task: string } | null
}
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export type Permission = {
  kind: "permission"
  id: ItemId
  toolName: string
  summary: string
  decision: "pending" | "allowed" | "denied"
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
}
export type TurnStart = { kind: "turn-start"; id: ItemId; model: string }
export type SystemEvent = { kind: "system"; id: ItemId; text: string; level: "info" | "warning" }

export type Item = UserMessage | AssistantText | Thinking | ToolCall | Permission | TurnStart | TurnEnd | SystemEvent

export type SessionInfo = {
  id: string
  model: string
  permissionMode: string
  cwd: string
  cliVersion: string
  tools: string[]
  mcpServers: { name: string; status: string }[]
  skills: string[]
}

export type SessionStatus = "idle" | "running" | "ended"

export type Session = {
  info: SessionInfo | null
  status: SessionStatus
  items: ItemId[]
  byId: Record<ItemId, Item>
}
