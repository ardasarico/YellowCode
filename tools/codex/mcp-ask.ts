// A local MCP server over stdio for Codex recordings: one `pick` tool that asks the user for a color through an
// elicitation and answers with what came back. It runs under node, which strips its types, so it imports nothing.
import { createInterface } from "node:readline"

const tool = {
  name: "pick",
  description: "Asks the user for a color",
  inputSchema: { type: "object", properties: {} },
}

const FORM = {
  message: "Which color should the button be?",
  requestedSchema: {
    type: "object",
    properties: {
      color: { type: "string", title: "Color", enum: ["blue", "green"], enumNames: ["Blue", "Green"] },
    },
    required: ["color"],
  },
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined

const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)

// Calls that wait for their elicitation's answer, by the elicitation's id.
const waiting = new Map<string, unknown>()
let asked = 0

for await (const line of createInterface({ input: process.stdin })) {
  let message: unknown = null
  try {
    message = JSON.parse(line)
  } catch {
    // A line that is no JSON gets no answer.
  }
  const id = field(message, "id")
  const method = field(message, "method")
  if (id === undefined) continue
  if (method === undefined) {
    const call = typeof id === "string" ? waiting.get(id) : undefined
    if (call === undefined || typeof id !== "string") continue
    waiting.delete(id)
    const result = field(message, "result")
    const text = `${String(field(result, "action"))}: ${JSON.stringify(field(result, "content") ?? null)}`
    send({ id: call, result: { content: [{ type: "text", text }] } })
    continue
  }
  if (method === "initialize")
    send({
      id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ask", version: "1" } },
    })
  else if (method === "tools/list") send({ id, result: { tools: [tool] } })
  else if (method === "tools/call") {
    const own = `elicit-${++asked}`
    waiting.set(own, id)
    send({ id: own, method: "elicitation/create", params: FORM })
  } else send({ id, result: {} })
}
