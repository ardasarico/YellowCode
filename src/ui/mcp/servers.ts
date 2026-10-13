import type { McpServer, SessionInfo } from "../../session/types.ts"

export type McpState = "failed" | "needs-login" | "connecting" | "connected" | "off"
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
  disabled: "off",
}
const RANK: Record<McpState, number> = { failed: 0, "needs-login": 1, connecting: 2, connected: 2, off: 3 }

// Claude Code lists the dynamic scope as its built-in servers.
const TAGS: Record<string, string> = { claudeai: "claude.ai", dynamic: "built-in", enterprise: "managed" }

function placement(origin: string | null): Pick<McpEntry, "group" | "tag" | "where"> {
  if (origin === "project") return { group: "project", tag: "shared", where: "this project · .mcp.json" }
  if (origin === "local") return { group: "project", tag: "", where: "this project · only you" }
  if (origin === "user") return { group: "user", tag: "", where: "all projects" }
  const tag = (origin && TAGS[origin]) ?? origin ?? ""
  return { group: "other", tag, where: tag }
}

// "plugin:figma:figma" is figma, "claude.ai Gmail" is Gmail; the tag says where they come from.
export function shortName(name: string): string {
  return /^plugin:[^:]+:(.+)$/.exec(name)?.[1] ?? name.replace(/^claude\.ai /, "")
}

export function mcpEntries(info: SessionInfo | null): McpEntry[] {
  return (info?.mcpServers ?? [])
    .map((server) => {
      const prefix = toolPrefix(server.name)
      const tools =
        server.tools ?? info?.tools.filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length))
      const { group, tag, where } = placement(server.source ?? server.scope)
      return {
        server,
        label: shortName(server.name),
        tag,
        group,
        where,
        state: STATES[server.status] ?? "connected",
        tools: tools ?? [],
      }
    })
    .toSorted((a, b) => RANK[a.state] - RANK[b.state])
}
