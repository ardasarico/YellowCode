import type { McpPlace, McpServerRow, McpState } from "../../agent/lists.ts"

export type McpGroup = "project" | "user" | "other"

export type McpEntry = {
  row: McpServerRow
  tag: string
  group: McpGroup
  where: string
  tools: string[]
}

export const MCP_GROUPS: [McpGroup, string][] = [
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

const entryOf = (row: McpServerRow): McpEntry => ({ row, tools: row.tools ?? [], ...placement(row) })

export const mcpEntries = (rows: McpServerRow[] | null): McpEntry[] =>
  (rows ?? []).map(entryOf).toSorted((a, b) => RANK[a.row.state] - RANK[b.row.state])
