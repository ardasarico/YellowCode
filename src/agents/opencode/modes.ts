// opencode's primary agents are its modes. The list comes through the allowlist, since an agent carries its provider
// request settings and headers.
import { z } from "zod"
import type { ModeKind, ModeRow } from "../../agent/lists.ts"
import type { WireModel } from "./translate.ts"
import { agentRow, readAllowed } from "./allow.ts"
import { planFolders } from "./plan.ts"
import type { Transport } from "./transport.ts"
import { rowsOf } from "./wire/envelope.ts"

type AgentRow = z.output<typeof agentRow>

// Question H: build is the normal mode, plan the plan mode, and any other agent a mode of its own.
const KINDS: Record<string, ModeKind> = { build: "auto", plan: "plan" }

export type Modes = {
  rows: ModeRow[]
  // Where the plan modes write their plans, as opencode patterns.
  planFolders: string[]
  // The modes that run a model of their own while the session has no pick.
  models: Map<string, WireModel>
}

// An "all" agent runs as a primary one too. opencode lists its default agent first.
export function modesOf(agents: AgentRow[]): Modes {
  const primary = agents.filter((agent) => agent.mode !== "subagent" && agent.hidden !== true)
  const rows = primary.map((agent): ModeRow => ({
    id: agent.id,
    label: agent.id,
    description: agent.description ?? "",
    kind: KINDS[agent.id] ?? "other",
    cycle: true,
    available: true,
    group: null,
  }))
  const plans = primary.filter((agent) => KINDS[agent.id] === "plan")
  const models = new Map(primary.flatMap((agent) => (agent.model ? [[agent.id, agent.model] as const] : [])))
  return { rows, planFolders: plans.flatMap((agent) => planFolders(agent.permissions ?? [])), models }
}

// Null when opencode did not list them.
export async function readModes(transport: Transport): Promise<Modes | null> {
  const data = await readAllowed(transport, "/api/agent", "the agents")
  return Array.isArray(data) ? modesOf(rowsOf(data, agentRow, "agent")) : null
}
