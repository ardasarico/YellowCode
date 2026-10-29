// A local MCP server over stdio for opencode recordings: one `echo` tool that answers with its text. It runs under
// node, which strips its types, so it imports nothing.
import { createInterface } from "node:readline"

const tool = {
  name: "echo",
  description: "Answers with the text it is given",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined

function resultOf(method: unknown, params: unknown): unknown {
  if (method === "initialize")
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "echo", version: "1.0.0" },
    }
  if (method === "tools/list") return { tools: [tool] }
  if (method === "tools/call")
    return { content: [{ type: "text", text: `echo: ${String(field(field(params, "arguments"), "text"))}` }] }
  return {}
}

for await (const line of createInterface({ input: process.stdin })) {
  let request: unknown = null
  try {
    request = JSON.parse(line)
  } catch {
    // A line that is no JSON gets no answer.
  }
  const id = field(request, "id")
  if (id === undefined) continue
  const result = resultOf(field(request, "method"), field(request, "params"))
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}
