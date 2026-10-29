import { type Capabilities, FEATURES } from "../../agent/capabilities.ts"
import type { ListName } from "../../agent/lists.ts"

export const CLAUDE = "claude"
export const CLAUDE_NAME = "Claude Code"
export const CLAUDE_SHORT_NAME = "Claude"

// Not "rules": claude keeps them in its own /permissions, which a typed /permissions opens.
const LISTS: ListName[] = ["commands", "models", "modes", "skills", "mcp", "loaded", "plugins", "subagents", "hooks"]

export const CLAUDE_CAPS: Capabilities = {
  steer: true,
  queue: false,
  images: true,
  fileSuggestions: true,
  askNote: true,
  ownQuestions: true,
  clientTools: "live",
  mcpServers: "live",
  instructions: true,
  planSignal: "ask",
  cut: true,
  fork: true,
  restart: true,
  subagents: true,
  backgroundTasks: true,
  backgroundNow: true,
  stopTask: true,
  taskOutput: true,
  effort: true,
  extraEffort: "ultracode",
  thinking: true,
  rename: true,
  titles: "none",
  context: "categories",
  usageReport: true,
  limits: true,
  cost: true,
  heldElsewhere: { atOpen: true, live: false },
  lists: LISTS,
  mcp: { toggle: true, reconnect: true, login: true },
  skills: { toggle: true, reload: true },
  plugins: { toggle: true, reload: true },
  settings: true,
  features: FEATURES,
}
