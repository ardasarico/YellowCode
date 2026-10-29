import { type Capabilities, FEATURES } from "../../agent/capabilities.ts"
import type { ListName } from "../../agent/lists.ts"

export const CLAUDE = "claude"

const ALL_LISTS: ListName[] = [
  "commands",
  "models",
  "modes",
  "skills",
  "mcp",
  "loaded",
  "plugins",
  "subagents",
  "hooks",
  "rules",
]

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
  lists: ALL_LISTS,
  mcp: { toggle: true, reconnect: true, login: true },
  skills: { toggle: true, reload: true },
  plugins: { toggle: true, reload: true },
  settings: true,
  features: FEATURES,
}
