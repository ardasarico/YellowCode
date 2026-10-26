import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js"
import { z } from "zod"
import packageJson from "../../package.json"
import { log } from "../log/log.ts"
import type { ModToolResult } from "../mods/api.ts"
import type { ModEntry } from "../mods/host.ts"
import { modTools } from "../mods/registry.ts"
import { type McpMessage, OWN_ASK_SERVER } from "../protocol/messages.ts"
import { mcpAck, mcpError, mcpResponse, mcpSetServersRequest } from "../protocol/outgoing.ts"
import type { Requests } from "./requests.ts"
import { OWN_ASK_TIMEOUT_MS } from "./own-ask-tool.ts"

// Each mod's tools are an in-process MCP server named mod-<id>; its manifest's servers are mod-<id>-<name>.
const PREFIX = "mod-"
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

export const isModServer = (name: string) => name.startsWith(PREFIX)
const modOf = (server: string) => server.slice(PREFIX.length)

const toolCall = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
const initializeParams = z.looseObject({ protocolVersion: z.string() })

function resultOf(result: ModToolResult) {
  const { text, isError } = typeof result === "string" ? { text: result, isError: false } : result
  return { content: [{ type: "text", text }], isError: isError === true }
}

// A throwing tool is an error Claude reads; it does not turn the mod off.
async function call(mod: string, params: unknown) {
  const parsed = toolCall.safeParse(params)
  const tool = parsed.success ? modTools().find((entry) => entry.mod === mod && entry.name === parsed.data.name) : null
  if (!parsed.success || !tool) return { content: [{ type: "text", text: "Unknown tool" }], isError: true }
  try {
    return resultOf(await tool.run(parsed.data.arguments ?? {}))
  } catch (error) {
    log.warn(`mod ${mod}: tool ${tool.name} failed`, error)
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }
  }
}

export function serveModTools(send: (line: string) => void, requestId: string, request: McpMessage): void {
  const mod = modOf(request.server_name)
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
      return send(
        mcpResponse(requestId, id, {
          tools: modTools()
            .filter((tool) => tool.mod === mod)
            .map(({ name, description, input, annotations }) =>
              annotations
                ? { name, description, inputSchema: input, annotations }
                : { name, description, inputSchema: input },
            ),
        }),
      )
    case "tools/call":
      void call(mod, params).then((result) => send(mcpResponse(requestId, id, result)))
      return
    case undefined:
    default:
      return send(mcpError(requestId, id, METHOD_NOT_FOUND, `Method not found: ${method}`))
  }
}

// The servers claude should have: our ask server, every running mod's tools, and its manifest's servers.
export function modServerConfigs(entries: readonly ModEntry[]): Record<string, unknown> {
  const servers: Record<string, unknown> = {
    [OWN_ASK_SERVER]: { type: "sdk", name: OWN_ASK_SERVER, timeout: OWN_ASK_TIMEOUT_MS },
  }
  const withTools = new Set(modTools().map((tool) => tool.mod))
  for (const entry of entries) {
    if (entry.status !== "on") continue
    if (withTools.has(entry.id)) servers[`${PREFIX}${entry.id}`] = { type: "sdk", name: `${PREFIX}${entry.id}` }
    for (const [name, config] of Object.entries(entry.manifest?.mcpServers ?? {}))
      // Ids never hold "--", so a manifest server cannot take another mod's name.
      servers[`${PREFIX}${entry.id}--${name}`] = config
  }
  return servers
}

const setServersReply = z.looseObject({ errors: z.record(z.string(), z.string()).optional() })

// MCP connection errors of mod servers, by server name, for /mods.
const [serverErrors, setServerErrors] = createSignal<Record<string, string>>({})
export { serverErrors }

// Each mod's tool names, so a change in them can be told apart from a change in the servers.
function toolNames(): Record<string, string> {
  const names: Record<string, string[]> = {}
  for (const tool of modTools()) (names[tool.mod] ??= []).push(tool.name)
  return Object.fromEntries(Object.entries(names).map(([mod, list]) => [mod, list.toSorted().join(",")]))
}

// Keeps claude's dynamic MCP servers in step with the running mods, from initialize on.
export function syncModServers(requests: Requests, entries: () => readonly ModEntry[]): () => void {
  const configs = () => modServerConfigs(entries())
  const setServers = (servers: Record<string, unknown>) =>
    requests
      .send((id) => mcpSetServersRequest(id, servers))
      .then(
        (reply) => {
          const errors = setServersReply.safeParse(reply).data?.errors ?? {}
          setServerErrors(errors)
          if (Object.keys(errors).length > 0) log.warn("mod MCP servers failed", errors)
        },
        (error: unknown) => log.warn("mcp_set_servers failed", error instanceof Error ? error.message : error),
      )
  let sentTools: Record<string, string> = {}
  return createRoot((dispose) => {
    // Entries change on every load and error; only a different config or tool list is sent.
    const wanted = createMemo(() => JSON.stringify([configs(), toolNames()]))
    createEffect(
      on(wanted, () => {
        const servers = configs()
        const tools = toolNames()
        // claude lists a server's tools once and ignores a config it already has, so a server whose tools changed
        // is removed and added again to make claude list them anew.
        const changed = Object.keys(tools).filter(
          (mod) => sentTools[mod] !== undefined && sentTools[mod] !== tools[mod] && `${PREFIX}${mod}` in servers,
        )
        sentTools = tools
        const without = Object.fromEntries(
          Object.entries(servers).filter(([name]) => !changed.some((mod) => name === `${PREFIX}${mod}`)),
        )
        void (changed.length > 0 ? setServers(without).then(() => setServers(servers)) : setServers(servers))
      }),
    )
    return dispose
  })
}
