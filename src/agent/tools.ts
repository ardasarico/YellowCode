export const TOOL_KINDS = [
  "shell",
  "read",
  "search",
  "edit",
  "write",
  "delete",
  "move",
  "fetch",
  "websearch",
  "agent",
  // A message to a running subagent.
  "message",
  "workflow",
  "question",
  // A finished plan put up for approval.
  "plan",
  // A switch to another of the agent's modes.
  "mode",
  "think",
  "skill",
  "todo",
  "mcp",
  "other",
] as const

// What a tool does, whatever the agent calls it. Folding, grouping, band styling, rewind and mods go by it.
export type ToolKind = (typeof TOOL_KINDS)[number]

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

// A file a call wrote, for rewind. `before` is the whole file before the call, null when the call made it, and
// absent when the agent does not say. `after` is what the call left in it, when the agent says.
export type FileChange = {
  // Absolute.
  path: string
  change: "create" | "update" | "delete" | "move"
  movedTo: string | null
  patch: Hunk[] | null
  before?: string | null
  after: string | null
}

// `data` is base64; null when only the path is known.
export type Image = { name: string; mediaType: string; data: string | null; path: string | null }

// A call that starts a subagent, as its input names it.
export type SubagentCall = { name: string; task: string; prompt: string; type: string; model: string }

// `id` stays the same while the text changes.
export type Todo = { id: string; text: string; state: "pending" | "running" | "done" }
