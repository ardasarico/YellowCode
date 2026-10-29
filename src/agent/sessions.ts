import type { AgentEvent } from "./events.ts"
import type { AgentKindId, ModelRef, PromptId } from "./ids.ts"

// `id` is the agent's own session id.
export type SessionRef = { agent: AgentKindId; id: string }

export type SessionEntry = {
  ref: SessionRef
  title: string
  firstPrompt: string
  cwd: string
  branch: string | null
  model: ModelRef | null
  // Epoch milliseconds.
  modified: number
}

export type HistoryCursor = string

// Oldest first. `earlier` reads the page before this one; null at the start of the session.
export type HistoryPage = { events: AgentEvent[]; earlier: HistoryCursor | null }

// What the agent's own backups hold for one prompt. Paths are absolute.
export type FileBackup = {
  prompt: PromptId
  at: number
  files: {
    path: string
    // What the prompt's calls did to the file; null when only a subagent's call names it.
    change: "create" | "update" | null
    // The agent's copy of the file before the prompt, read as bytes; null when the prompt made the file, "missing"
    // when there is no readable copy.
    before: { copy: string } | null | "missing"
    // The text the prompt's last call left in the file; null when that cannot be worked out.
    after: string | null
  }[]
}
