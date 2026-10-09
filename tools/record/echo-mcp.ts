// A stdio MCP server with one tool, `echo`, for the mcp recording scenario.
import { createInterface } from "node:readline"
import { z } from "zod"
import { parseJson } from "../../src/protocol/json.ts"

const rpcRequest = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z
    .looseObject({
      protocolVersion: z.string().optional(),
      arguments: z.looseObject({ text: z.string().optional() }).optional(),
    })
    .optional(),
})
type RpcRequest = z.infer<typeof rpcRequest>

function reply(id: number | string, body: { result: unknown } | { error: { code: number; message: string } }): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n")
}

function resultFor(request: RpcRequest): unknown {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "1.0.0" },
      }
    case "tools/list":
      return {
        tools: [
          {
            name: "echo",
            description: "Returns the given text.",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      }
    case "tools/call":
      return { content: [{ type: "text", text: request.params?.arguments?.text ?? "" }] }
    default:
      return undefined
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const json = parseJson(line)
  const parsed = json.ok ? rpcRequest.safeParse(json.value) : null
  const id = parsed?.data?.id
  if (!parsed?.success || id === undefined) return
  const result = resultFor(parsed.data)
  if (result === undefined) reply(id, { error: { code: -32601, message: `Unknown method ${parsed.data.method}` } })
  else reply(id, { result })
})
