import { appVersion } from "../build-info.ts"
import { z } from "zod"
import type { ClientTool } from "../agent/agent.ts"
import { ownAskProblem } from "../agents/claude/ask-input.ts"
import { log } from "../log/log.ts"
import { type McpMessage, OWN_ASK, OWN_ASK_SERVER, ownAskCall, type ProtocolMessage } from "../protocol/messages.ts"
import {
  errorResponse,
  mcpAck,
  mcpError,
  mcpResponse,
  mcpToolError,
  NOT_SHOWN,
  SUBAGENT_ASK,
} from "../protocol/outgoing.ts"
import { isModServer, serveModTools } from "./mod-tools.ts"
import { OWN_ASK_TOOL } from "./own-ask-tool.ts"

const initializeParams = z.looseObject({ protocolVersion: z.string() })

const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
// A foreground subagent's tool_use line comes right after its call; one that never comes opens the ask.
const LINE_WAIT_MS = 5000

export type AskServer = {
  // Every line claude sends, so the server learns who made each call.
  seen(message: ProtocolMessage): void
  serve(requestId: string, request: McpMessage): void
  close(): void
}

// Our own ask's MCP server. claude can send its MCP initialize before it answers ours, so nothing here waits for the
// session. A call the user may see gets no reply here: the session opens it, and the user's answer is the reply.
// Only the main agent may ask; a subagent's call is turned down, known by its tool_use line's parent. `open` places a
// main call the session held because its line came after it. The mods' servers are served from `clientTools`.
export function createAskServer(
  send: (line: string) => void,
  open: (toolUseId: string) => void,
  clientTools: () => readonly ClientTool[],
): AskServer {
  // tool_use id of each own ask call → the Agent call it runs under, or null on the main thread.
  const parents = new Map<string, string | null>()
  // Calls whose tool_use line is still to come, with what to do if it names a subagent.
  const waiting = new Map<string, { refuse: () => void; timer: ReturnType<typeof setTimeout> }>()

  function call(requestId: string, rpcId: string | number, params: unknown): void {
    const parsed = ownAskCall.safeParse(params).data
    if (parsed?.name !== OWN_ASK_TOOL.name)
      return send(mcpError(requestId, rpcId, INVALID_PARAMS, `Unknown tool: ${parsed?.name}`))
    const problem = ownAskProblem({ toolName: OWN_ASK, input: parsed.input })
    if (problem !== null) return send(mcpToolError(requestId, rpcId, `${NOT_SHOWN}${problem}.`))
    const refuse = () => send(mcpToolError(requestId, rpcId, SUBAGENT_ASK))
    const parent = parents.get(parsed.toolUseId)
    if (parent) return refuse()
    // The session opens it too; a second open does nothing.
    if (parent === null) return open(parsed.toolUseId)
    const timer = setTimeout(() => {
      waiting.delete(parsed.toolUseId)
      log.warn("own ask: no tool_use line for the call, so it opens as the main agent's")
      open(parsed.toolUseId)
    }, LINE_WAIT_MS)
    waiting.set(parsed.toolUseId, { refuse, timer })
  }

  return {
    seen(message) {
      if (message.type !== "assistant") return
      for (const block of message.message.content) {
        if (block.type !== "tool_use" || block.name !== OWN_ASK) continue
        const parent = message.parent_tool_use_id ?? null
        parents.set(block.id, parent)
        const held = waiting.get(block.id)
        if (!held) continue
        clearTimeout(held.timer)
        waiting.delete(block.id)
        if (parent) held.refuse()
        else open(block.id)
      }
    },
    serve(requestId, request) {
      const served =
        request.server_name !== OWN_ASK_SERVER && clientTools().some((tool) => tool.server === request.server_name)
      if (isModServer(request.server_name) || served) return serveModTools(send, requestId, request, clientTools())
      if (request.server_name !== OWN_ASK_SERVER)
        return send(errorResponse(requestId, "YellowCode does not support mcp_message"))
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
              serverInfo: { name: OWN_ASK_SERVER, version: appVersion },
            }),
          )
        }
        case "ping":
          return send(mcpResponse(requestId, id, {}))
        case "tools/list":
          return send(mcpResponse(requestId, id, { tools: [OWN_ASK_TOOL] }))
        case "tools/call":
          return call(requestId, id, params)
        case undefined:
        default:
          log.warn("own ask server: unknown method", method)
          return send(mcpError(requestId, id, METHOD_NOT_FOUND, `Method not found: ${method}`))
      }
    },
    close() {
      for (const held of waiting.values()) clearTimeout(held.timer)
      waiting.clear()
    },
  }
}
