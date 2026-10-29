import type { McpPlace, McpServerRow, McpState } from "../../agent/lists.ts"
import type { McpServer } from "../../session/types.ts"

// MCP tool names carry the server name with every character outside [A-Za-z0-9_-] replaced by `_`.
export const toolPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`

// "plugin:figma:figma" is figma, "claude.ai Gmail" is Gmail; the place says where they come from.
export function shortName(name: string): string {
  return /^plugin:[^:]+:(.+)$/.exec(name)?.[1] ?? name.replace(/^claude\.ai /, "")
}

const STATES = new Map<string, McpState>(
  Object.entries({
    failed: "failed",
    "needs-auth": "needs-login",
    pending: "connecting",
    connected: "connected",
    disabled: "off",
  }),
)

export const stateOf = (status: string): McpState => STATES.get(status) ?? "unknown"

// claude lists its built-in servers under the dynamic scope.
const PLACES = new Map<string, McpPlace>(
  Object.entries({
    project: "project-shared",
    local: "project-private",
    user: "everywhere",
    claudeai: "account",
    dynamic: "builtin",
    enterprise: "managed",
  }),
)

export const placeOf = (origin: string | null): McpPlace => (origin && PLACES.get(origin)) || "other"

const ORIGINS = new Map([["claudeai", "claude.ai"]])

// `tools` is the session's tool list, for a server whose own list claude has not reported.
export function mcpRows(servers: McpServer[] | null, tools: string[]): McpServerRow[] | null {
  return (
    servers?.map((server) => {
      const prefix = toolPrefix(server.name)
      const origin = server.source ?? server.scope
      return {
        name: server.name,
        label: shortName(server.name),
        place: placeOf(origin),
        state: stateOf(server.status),
        status: server.status,
        origin: origin && (ORIGINS.get(origin) ?? origin),
        scope: server.scope,
        error: server.error,
        config: server.config,
        server: server.serverInfo,
        tools: server.tools ?? tools.filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length)),
      }
    }) ?? null
  )
}
