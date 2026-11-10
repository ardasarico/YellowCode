import type { McpPlace, McpServerRow, McpState } from "../../agent/lists.ts"
import type { SharedSession } from "../../mcp/handover.ts"
import { globalFile, type McpScope } from "../../mcp/servers.ts"
import { tildePath } from "../../rewind/common.ts"
import { shownText } from "../format.ts"

export type McpGroup = "shared" | "project" | "user" | "other"

// `own`: a row of the agent's list. `shared`: a shared server the agent lists. `handed`: one it was given and does not
// list. `held`: one it was not given, `problem` says why. `replaced`: the agent's own server a shared one stands in for.
export type McpKind = "own" | "shared" | "handed" | "held" | "replaced"

export type McpEntry = {
  id: string
  kind: McpKind
  row: McpServerRow
  tag: string
  group: McpGroup
  where: string
  tools: string[]
  // Shown in place of the state; `attention` gives it the problem look.
  problem: string | null
  attention: boolean
}

export const MCP_GROUPS: [McpGroup, string][] = [
  ["shared", "Shared"],
  ["project", "This project"],
  ["user", "All projects"],
  ["other", "Other"],
]

const RANK: Record<McpState, number> = {
  failed: 0,
  "needs-login": 1,
  connecting: 2,
  connected: 2,
  unknown: 2,
  off: 3,
}

const rankOf = (entry: McpEntry) => (entry.problem === null ? RANK[entry.row.state] : entry.attention ? 0 : 3)

type Placement = Pick<McpEntry, "group" | "tag" | "where">

const PLACEMENTS: Partial<Record<McpPlace, Placement>> = {
  "project-shared": { group: "project", tag: "shared", where: "This project · shared" },
  "project-private": { group: "project", tag: "", where: "This project · only you" },
  everywhere: { group: "user", tag: "", where: "All projects" },
}

const TAGS: Partial<Record<McpPlace, string>> = { builtin: "built-in", managed: "managed" }

function placement(row: McpServerRow): Placement {
  const fixed = PLACEMENTS[row.place]
  if (fixed) return fixed
  const tag = TAGS[row.place] ?? row.origin ?? ""
  return { group: "other", tag, where: tag }
}

const sharedWhere = (scope: McpScope) =>
  scope === "global" ? `Shared · ${tildePath(globalFile())}` : "Shared · this project's .mcp.json"

const bare = (name: string, state: McpState): McpServerRow => ({
  name,
  label: name,
  place: "other",
  state,
  status: "",
  origin: null,
  scope: null,
  error: null,
  config: null,
  server: null,
  tools: null,
  toolServer: name,
})

// A provider's own name can carry marks that pass for other letters.
const shownRow = (row: McpServerRow): McpServerRow => ({ ...row, label: shownText(row.label) })

const ownEntry = (row: McpServerRow): McpEntry => ({
  id: row.name,
  kind: "own",
  row: shownRow(row),
  tools: row.tools ?? [],
  problem: null,
  attention: false,
  ...placement(row),
})

const sharedEntry = (kind: McpKind, row: McpServerRow, scope: McpScope): McpEntry => ({
  id: `shared:${row.name}`,
  kind,
  row: shownRow(row),
  tag: "",
  group: "shared",
  where: sharedWhere(scope),
  tools: row.tools ?? [],
  problem: null,
  attention: false,
})

// The agent's rows, with the shared servers of the session in a group of their own: a shared server the agent lists
// keeps the agent's row, and so its state and actions.
export function mcpEntries(rows: McpServerRow[] | null, shared?: SharedSession | null): McpEntry[] {
  const listed = rows ?? []
  const handed = new Set(shared?.servers.map((server) => server.name))
  // claude lists the project's .mcp.json, which it was told to leave off, as its own.
  const fromProject = new Set(
    [...(shared?.servers ?? []), ...(shared?.held ?? [])]
      .filter((one) => one.scope === "project")
      .map((one) => one.name),
  )
  const entries = listed
    .filter((row) => !handed.has(row.name) && !(row.place === "project-shared" && fromProject.has(row.name)))
    .map(ownEntry)
  for (const { name, scope } of shared?.servers ?? []) {
    const row = listed.find((one) => one.name === name)
    entries.push(row ? sharedEntry("shared", row, scope) : sharedEntry("handed", bare(name, "unknown"), scope))
  }
  for (const { name, scope, problem, waiting } of shared?.held ?? [])
    entries.push({
      ...sharedEntry("held", bare(name, "off"), scope),
      problem,
      attention: !waiting,
    })
  for (const name of shared?.replaced ?? [])
    entries.push({
      ...ownEntry(bare(name, "off")),
      id: `replaced:${name}`,
      kind: "replaced",
      problem: `off · replaced by the shared ${shownText(name)}`,
    })
  return entries.toSorted((a, b) => rankOf(a) - rankOf(b))
}

export const hasShared = (shared: SharedSession | null | undefined) =>
  shared != null && shared.servers.length + shared.held.length > 0

// The sidebar lists a shared server that is not running among the failed ones, its problem as the error.
export function withHeld(rows: McpServerRow[] | null, shared: SharedSession | null | undefined): McpServerRow[] | null {
  const held = (shared?.held ?? []).filter((server) => !server.waiting)
  if (held.length === 0) return rows
  return [...(rows ?? []), ...held.map(({ name, problem }) => Object.assign(bare(name, "failed"), { error: problem }))]
}
