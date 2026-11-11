// The memory tools as an MCP server over stdio, for an agent that takes no client tools: YellowCode starts itself as
// `yellowcode memory-server <folder>`, and the agent runs that as one of its servers.
import { z } from "zod"
import type { McpLaunch } from "../agent/agent.ts"
import { appVersion, compiled } from "../build-info.ts"
import { parseJson } from "../json.ts"
import { callClientTool, mcpToolEntry } from "../protocol/mcp-tools.ts"
import { MEMORY_SERVER, memoryClientTools } from "./tools.ts"

export const MEMORY_COMMAND = "memory-server"

const PROTOCOL = "2025-06-18"
const METHOD_NOT_FOUND = -32601

const request = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})
const initialize = z.looseObject({ protocolVersion: z.string() })

// A run from source starts through bun with the launcher's flags; a standalone binary is the program itself.
export function memoryLaunch(folder: string): McpLaunch {
  const self = compiled ? [] : [...process.execArgv, process.argv[1] ?? ""]
  return { name: MEMORY_SERVER, command: process.execPath, args: [...self, MEMORY_COMMAND, folder], env: {} }
}

export async function answer(line: string, folder: string): Promise<string | null> {
  const json = parseJson(line)
  const message = json.ok ? request.safeParse(json.value).data : undefined
  if (message?.id === undefined) return null
  const reply = (body: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body })
  const tools = memoryClientTools(folder)
  if (message.method === "initialize")
    return reply({
      result: {
        protocolVersion: initialize.safeParse(message.params).data?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: MEMORY_SERVER, version: appVersion },
      },
    })
  if (message.method === "ping") return reply({ result: {} })
  if (message.method === "tools/list") return reply({ result: { tools: tools.map(mcpToolEntry) } })
  if (message.method === "tools/call") return reply({ result: await callClientTool(tools, message.params) })
  return reply({ error: { code: METHOD_NOT_FOUND, message: `Unknown method ${message.method}` } })
}

export async function runMemoryServer(folder: string | undefined): Promise<number> {
  if (!folder) {
    process.stderr.write(`Usage: yellowcode ${MEMORY_COMMAND} <folder>\n`)
    return 1
  }
  const decoder = new TextDecoder()
  let rest = ""
  for await (const chunk of Bun.stdin.stream()) {
    rest += decoder.decode(chunk, { stream: true })
    const lines = rest.split("\n")
    rest = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim() === "") continue
      // oxlint-disable-next-line no-await-in-loop -- calls are answered in the order they came
      const said = await answer(line, folder)
      if (said !== null) process.stdout.write(`${said}\n`)
    }
  }
  return 0
}
