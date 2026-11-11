import type { Capabilities } from "../../agent/capabilities.ts"

export const OPENCODE = "opencode"
export const OPENCODE_NAME = "opencode"

// Each stage turns on only what it built, so the UI never offers what is not there yet.
export const OPENCODE_CAPS: Capabilities = {
  steer: true,
  queue: true,
  images: true,
  fileSuggestions: true,
  askNote: true,
  ownQuestions: true,
  clientTools: "live",
  mcpServers: "start",
  ownMcpOff: true,
  // Only its service can leave plugins off, for every window it serves and until it restarts.
  pluginsOff: false,
  instructions: true,
  planSignal: "file",
  cut: true,
  fork: true,
  restart: true,
  subagents: true,
  backgroundTasks: true,
  backgroundNow: true,
  stopTask: true,
  taskOutput: true,
  effort: true,
  extraEffort: null,
  thinking: false,
  rename: true,
  titles: "agent",
  context: "total",
  usageReport: false,
  limits: true,
  cost: true,
  heldElsewhere: { atOpen: false, live: false },
  lists: ["rules", "modes", "models", "commands", "skills", "mcp"],
  mcp: {
    toggle: true,
    reconnect: true,
    login: false,
    reach: "Applies to every opencode window in this folder.",
    failNotice: true,
  },
  skills: { toggle: false, reload: false },
  settings: true,
  features: [],
}
