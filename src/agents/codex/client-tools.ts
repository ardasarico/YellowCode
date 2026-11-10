// The tools YellowCode hands Codex as dynamic tools: our own ask, and each mod's tools under the mod's namespace. Codex
// keeps a thread's tools from its start on: a resumed thread still has them, and takes no others.
import type { ClientTool } from "../../agent/agent.ts"
import { OWN_ASK_DESCRIPTION, OWN_ASK_SCHEMA } from "../../source/own-ask-tool.ts"
import { ASK } from "./tools.ts"

const ASK_TOOL = {
  type: "function",
  name: ASK,
  description: OWN_ASK_DESCRIPTION.replaceAll("AskUserQuestion", "the question tool"),
  inputSchema: OWN_ASK_SCHEMA,
}

export function dynamicTools(tools: readonly ClientTool[]): unknown[] {
  const namespaces = Map.groupBy(tools, (tool) => tool.server)
  return [
    ASK_TOOL,
    ...[...namespaces].map(([server, own]) => ({
      type: "namespace",
      name: server,
      description: server.startsWith("mod-") ? `Tools of the YellowCode mod ${server}` : `YellowCode's ${server} tools`,
      tools: own.map(({ name, description, inputSchema }) => ({ type: "function", name, description, inputSchema })),
    })),
  ]
}

const inputOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {}

// A call Codex routes by namespace and name; one YellowCode does not have is an error result.
export async function runClientTool(
  tools: readonly ClientTool[],
  namespace: string | null,
  name: string,
  input: unknown,
): Promise<{ text: string; error: boolean }> {
  const tool = tools.find((known) => known.server === namespace && known.name === name)
  if (!tool) return { text: "Unknown tool", error: true }
  try {
    return await tool.run(inputOf(input))
  } catch (error) {
    return { text: error instanceof Error ? error.message : "The tool failed", error: true }
  }
}
