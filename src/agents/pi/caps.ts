import type { Capabilities } from "../../agent/capabilities.ts"

export const PI = "pi"
export const PI_NAME = "Pi"

// Each stage turns on only what it built, so the UI never offers what is not there yet. Pi has no approvals, plan
// mode or subagents, and none is emulated.
export const PI_CAPS: Capabilities = {
  steer: true,
  queue: true,
  images: true,
  fileSuggestions: true,
  askNote: false,
  ownQuestions: false,
  clientTools: "none",
  mcpServers: "none",
  instructions: true,
  planSignal: "none",
  cut: true,
  fork: true,
  restart: true,
  subagents: false,
  backgroundTasks: false,
  backgroundNow: false,
  stopTask: false,
  taskOutput: false,
  effort: true,
  extraEffort: null,
  thinking: false,
  rename: true,
  titles: "none",
  context: "total",
  usageReport: false,
  limits: false,
  cost: true,
  // Pi does not lock its session files, so nothing tells another program has one open.
  heldElsewhere: { atOpen: false, live: false },
  lists: ["commands", "modes", "models"],
  mcp: { toggle: false, reconnect: false, login: false, reach: null, failNotice: false },
  skills: { toggle: false, reload: false },
  plugins: { toggle: false, reload: false },
  settings: false,
  features: [],
}
