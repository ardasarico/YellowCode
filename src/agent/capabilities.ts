import type { ListName } from "./lists.ts"

// Features only some agents have, each named by what it does.
export const FEATURES = [
  // Multi-agent runs with phases, reported as one task.
  "workflows",
  // The user writes to a running subagent (Prompt.to).
  "agentMessages",
  // MCP servers that come with the user's account at the agent's vendor.
  "accountConnectors",
  // The agent keeps file backups of its own that rewind can import.
  "fileHistory",
] as const

export type Feature = (typeof FEATURES)[number]

// A missing feature is off, never emulated; a method behind an off capability is never called.
export type Capabilities = {
  // While a turn runs, a prompt can go into it at the next step (`steer`) or wait for it to end (`queue`).
  steer: boolean
  queue: boolean
  images: boolean
  fileSuggestions: boolean
  askNote: boolean
  // Our own ask tool stands in for the agent's question tool.
  ownQuestions: boolean
  // Tools and MCP servers YellowCode hands over: only when the session starts, or at any time.
  clientTools: "none" | "start" | "live"
  mcpServers: "none" | "start" | "live"
  // The agent's own configured MCP servers can be left off for a session (StartOptions.ownMcp).
  ownMcpOff: boolean
  // StartOptions.instructions reach the model.
  instructions: boolean
  // How the agent says a plan is finished: an ask, a plan item, a plan file it wrote, or not at all.
  planSignal: "ask" | "item" | "file" | "none"
  // The conversation can be cut back before a prompt, and the cut taken back until the next send.
  cut: boolean
  fork: boolean
  // An agent that went away can go on with the same session.
  restart: boolean
  subagents: boolean
  backgroundTasks: boolean
  // Ctrl+B: what runs in the foreground goes on in the background.
  backgroundNow: boolean
  stopTask: boolean
  taskOutput: boolean
  effort: boolean
  // A switch beyond the effort levels, under the agent's own name for it; null when there is none.
  extraEffort: string | null
  // Thinking can be shown or left out per session.
  thinking: boolean
  rename: boolean
  // The agent titles its sessions itself; otherwise YellowCode does.
  titles: "agent" | "none"
  // The /context dialog: by category, the total only, or none.
  context: "categories" | "total" | "none"
  usageReport: boolean
  limits: boolean
  cost: boolean
  // The agent can tell that another program has the session: before it opens, and while it runs.
  heldElsewhere: { atOpen: boolean; live: boolean }
  // The lists the agent fills; the UI hides the rest.
  lists: readonly ListName[]
  // `reach`: who else the server actions reach, said under them; null when it is this session alone.
  // `failNotice`: a server that turns failed in the MCP list raises a notice while the sidebar is hidden.
  mcp: { toggle: boolean; reconnect: boolean; login: boolean; reach: string | null; failNotice: boolean }
  skills: { toggle: boolean; reload: boolean }
  plugins: { toggle: boolean; reload: boolean }
  settings: boolean
  features: readonly Feature[]
}
