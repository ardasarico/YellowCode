import type { Capabilities } from "../../agent/capabilities.ts"

export const CODEX = "codex"
export const CODEX_NAME = "Codex"

// Each stage turns on only what it built, so the UI never offers what is not there yet.
export const CODEX_CAPS: Capabilities = {
  steer: true,
  queue: true,
  images: true,
  fileSuggestions: true,
  askNote: false,
  ownQuestions: true,
  clientTools: "start",
  mcpServers: "start",
  instructions: true,
  planSignal: "item",
  cut: true,
  fork: true,
  restart: true,
  subagents: true,
  backgroundTasks: true,
  backgroundNow: false,
  stopTask: true,
  taskOutput: false,
  effort: true,
  extraEffort: null,
  thinking: true,
  rename: true,
  titles: "none",
  context: "total",
  usageReport: false,
  limits: true,
  cost: false,
  // Only a resume finds out (another app-server's thread is refused), and it starts the thread's MCP servers; the
  // holder is told nothing.
  heldElsewhere: { atOpen: false, live: false },
  lists: ["models", "modes", "commands", "skills", "mcp", "plugins", "hooks"],
  // A reconnect reloads every server's config; a server is turned on and off only in config.toml. Plugins have no
  // switch in app-server.
  mcp: { toggle: false, reconnect: true, login: true, reach: null, failNotice: false },
  skills: { toggle: true, reload: true },
  plugins: { toggle: false, reload: false },
  settings: true,
  features: [],
}
