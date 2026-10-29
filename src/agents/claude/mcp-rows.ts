import type { McpPlace, McpServerRow, McpState } from "../../agent/lists.ts"
import { currentServers } from "../../session/lists.ts"
import type { SessionStore } from "../../session/session.ts"
import type { McpServer } from "../../session/types.ts"
import { mcpOf } from "./tools.ts"

// MCP tool names carry the server name with every character outside [A-Za-z0-9_-] replaced by `_`.
export const toolPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`

// The server a call of one of the server's tools names, as the tool's name is read.
export const toolServer = (server: string) => mcpOf(`${toolPrefix(server)}tool`)?.server ?? server

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
        toolServer: toolServer(server.name),
      }
    }) ?? null
  )
}

// The rows the UI shows follow the newest list, with the session's tools for a server that lists none.
export function showServers(session: SessionStore): void {
  const rows = mcpRows(currentServers(session.state, null), session.state.info?.tools ?? [])
  if (rows) session.setLists({ mcp: rows })
}
