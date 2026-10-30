// Client tools as an MCP server serves them, the same for every agent that takes them over MCP.
import { z } from "zod"
import type { ClientTool } from "../agent/agent.ts"

const toolCall = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })

export function mcpToolEntry({ name, description, inputSchema, annotations }: ClientTool) {
  if (annotations === null) return { name, description, inputSchema }
  const { readOnly, destructive, title } = annotations
  return {
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, title },
  }
}

const resultOf = ({ text, error }: { text: string; error: boolean }) => ({
  content: [{ type: "text", text }],
  isError: error,
})

// The result of a `tools/call` for one of `tools`.
export async function callClientTool(tools: readonly ClientTool[], params: unknown) {
  const parsed = toolCall.safeParse(params)
  const tool = parsed.success ? tools.find((entry) => entry.name === parsed.data.name) : undefined
  if (!parsed.success || !tool) return resultOf({ text: "Unknown tool", error: true })
  try {
    return resultOf(await tool.run(parsed.data.arguments ?? {}))
  } catch (error) {
    return resultOf({ text: error instanceof Error ? error.message : "The tool failed", error: true })
  }
}
