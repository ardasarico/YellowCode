import type { McpServer } from "../../session/types.ts"

export type McpState = "failed" | "needs-login" | "connecting" | "connected" | "off" | "unknown"
export type McpGroup = "project" | "user" | "other"

export type McpEntry = {
  server: McpServer
  label: string
  tag: string
  group: McpGroup
  where: string
  state: McpState
  tools: string[]
}

export const MCP_GROUPS: [McpGroup, string][] = [
  ["project", "This project"],
  ["user", "All projects"],
  ["other", "Other"],
]

// MCP tool names carry the server name with every character outside [A-Za-z0-9_-] replaced by `_`.
export const toolPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`

const STATES: Record<string, McpState> = {
  failed: "failed",
  "needs-auth": "needs-login",
  pending: "connecting",
  connected: "connected",
  disabled: "off",
}
const RANK: Record<McpState, number> = {
  failed: 0,
  "needs-login": 1,
  connecting: 2,
  connected: 2,
  unknown: 2,
  off: 3,
}

// Claude Code lists the dynamic scope as its built-in servers.
const TAGS: Record<string, string> = { claudeai: "claude.ai", dynamic: "built-in", enterprise: "managed" }

function placement(origin: string | null): Pick<McpEntry, "group" | "tag" | "where"> {
  if (origin === "project") return { group: "project", tag: "shared", where: "This project · shared" }
  if (origin === "local") return { group: "project", tag: "", where: "This project · only you" }
  if (origin === "user") return { group: "user", tag: "", where: "All projects" }
  const tag = (origin && TAGS[origin]) ?? origin ?? ""
  return { group: "other", tag, where: tag }
}

// "plugin:figma:figma" is figma, "claude.ai Gmail" is Gmail; the tag says where they come from.
export function shortName(name: string): string {
  return /^plugin:[^:]+:(.+)$/.exec(name)?.[1] ?? name.replace(/^claude\.ai /, "")
}

// `tools` is the session's tool list, for a server whose own list claude has not reported.
export function mcpEntries(servers: McpServer[] | null, tools: string[]): McpEntry[] {
  return (servers ?? [])
    .map((server) => {
      const prefix = toolPrefix(server.name)
      const own =
        server.tools ?? tools.filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length))
      const { group, tag, where } = placement(server.source ?? server.scope)
      return {
        server,
        label: shortName(server.name),
        tag,
        group,
        where,
        state: STATES[server.status] ?? "unknown",
        tools: own,
      }
    })
    .toSorted((a, b) => RANK[a.state] - RANK[b.state])
}
