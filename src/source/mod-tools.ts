import { type Accessor, createEffect, createMemo, createRoot, on } from "solid-js"
import { z } from "zod"
import packageJson from "../../package.json"
import type { ClientTool } from "../agent/agent.ts"
import { log } from "../log/log.ts"
import { MOD_SERVER_PREFIX as PREFIX, type ModHost } from "../mods/host.ts"
import { setModServerErrors } from "../mods/registry.ts"
import { callClientTool, mcpToolEntry } from "../protocol/mcp-tools.ts"
import { type McpMessage, OWN_ASK_SERVER } from "../protocol/messages.ts"
import { mcpAck, mcpError, mcpResponse, mcpSetServersRequest } from "../protocol/outgoing.ts"
import type { Requests } from "./requests.ts"
import { OWN_ASK_TIMEOUT_MS } from "./own-ask-tool.ts"
import { commandOf, safeText } from "./safe-text.ts"

const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

export const isModServer = (name: string) => name.startsWith(PREFIX)

const initializeParams = z.looseObject({ protocolVersion: z.string() })

// `tools` are the agent's client tools; the server's own are those it groups.
export function serveModTools(
  send: (line: string) => void,
  requestId: string,
  request: McpMessage,
  tools: readonly ClientTool[],
): void {
  const served = tools.filter((tool) => tool.server === request.server_name)
  const { id, method, params } = request.message
  if (id === undefined) return send(mcpAck(requestId))
  switch (method) {
    case "initialize": {
      const version = initializeParams.safeParse(params).data?.protocolVersion
      if (!version) return send(mcpError(requestId, id, INVALID_PARAMS, "initialize needs a protocolVersion"))
      return send(
        mcpResponse(requestId, id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: request.server_name, version: packageJson.version },
        }),
      )
    }
    case "ping":
      return send(mcpResponse(requestId, id, {}))
    case "tools/list":
      return send(mcpResponse(requestId, id, { tools: served.map(mcpToolEntry) }))
    case "tools/call":
      void callClientTool(served, params).then((result) => send(mcpResponse(requestId, id, result)))
      return
    case undefined:
    default:
      return send(mcpError(requestId, id, METHOD_NOT_FOUND, `Method not found: ${method}`))
  }
}

// The servers claude should have: our ask server, every running mod's tools and its manifest's servers, and
// YellowCode's other client tool servers.
export function modServerConfigs(
  host: Pick<ModHost, "entries" | "servers">,
  tools: readonly ClientTool[],
): Record<string, unknown> {
  const servers: Record<string, unknown> = {
    [OWN_ASK_SERVER]: { type: "sdk", name: OWN_ASK_SERVER, timeout: OWN_ASK_TIMEOUT_MS },
  }
  const withTools = new Set(tools.map((tool) => tool.server))
  for (const entry of host.entries) {
    if (entry.status !== "on") continue
    const name = `${PREFIX}${entry.id}`
    if (withTools.has(name)) servers[name] = { type: "sdk", name }
    Object.assign(servers, host.servers(entry.id))
  }
  // YellowCode's own tools may wait for the user, so claude gives them as long as its own ask.
  for (const name of withTools)
    if (!isModServer(name)) servers[name] = { type: "sdk", name, timeout: OWN_ASK_TIMEOUT_MS }
  return servers
}

const setServersReply = z.looseObject({ errors: z.record(z.string(), z.string()).optional() })

// Each server's tool names, so a change in them can be told apart from a change in the servers.
function toolNames(tools: readonly ClientTool[]): Record<string, string> {
  const names: Record<string, string[]> = {}
  for (const tool of tools) (names[tool.server] ??= []).push(tool.name)
  return Object.fromEntries(Object.entries(names).map(([server, list]) => [server, list.toSorted().join(",")]))
}

// Keeps claude's dynamic MCP servers in step with the client tools and the running mods' servers, from initialize on.
export function syncModServers(
  requests: Requests,
  host: Pick<ModHost, "entries" | "servers">,
  clientTools: Accessor<readonly ClientTool[]>,
): () => void {
  const configs = () => modServerConfigs(host, clientTools())
  const setServers = (servers: Record<string, unknown>) =>
    requests
      .send((id) => mcpSetServersRequest(id, servers))
      .then(
        (reply) => {
          const errors = setServersReply.safeParse(reply).data?.errors ?? {}
          const shown = Object.fromEntries(
            Object.entries(errors).map(([name, error]) => [name, safeText(error, commandOf(servers[name]))]),
          )
          setModServerErrors(shown)
          if (Object.keys(shown).length > 0) log.warn("mod MCP servers failed", shown)
        },
        (error: unknown) => log.warn("mcp_set_servers failed", error instanceof Error ? error.message : error),
      )
  let sentTools: Record<string, string> = {}
  return createRoot((dispose) => {
    // Entries change on every load and error; only a different config or tool list is sent.
    const wanted = createMemo(() => JSON.stringify([configs(), toolNames(clientTools())]))
    createEffect(
      on(wanted, () => {
        const servers = configs()
        const tools = toolNames(clientTools())
        // claude lists a server's tools once and ignores a config it already has, so a server whose tools changed
        // is removed and added again to make claude list them anew.
        const changed = Object.keys(tools).filter(
          (server) => sentTools[server] !== undefined && sentTools[server] !== tools[server] && server in servers,
        )
        sentTools = tools
        const without = Object.fromEntries(Object.entries(servers).filter(([name]) => !changed.includes(name)))
        void (changed.length > 0 ? setServers(without).then(() => setServers(servers)) : setServers(servers))
      }),
    )
    return dispose
  })
}
