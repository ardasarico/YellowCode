// The tools YellowCode hands Codex as dynamic tools: our own ask, and each mod's tools under the mod's namespace. Codex
// keeps a thread's tools from its start on: a resumed thread still has them, and takes no others.
import type { ClientTool, McpLaunch } from "../../agent/agent.ts"
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
      description: `Tools of the YellowCode mod ${server}`,
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
  return tool.run(inputOf(input))
}

// The mods' manifest servers as config overrides of the thread, which Codex starts with it.
export function serverConfig(servers: readonly McpLaunch[]): { config?: Record<string, unknown> } {
  if (servers.length === 0) return {}
  const entries = servers.map((server): [string, unknown] => {
    const fields =
      "url" in server
        ? { url: server.url, ...(Object.keys(server.headers).length > 0 ? { http_headers: server.headers } : {}) }
        : {
            command: server.command,
            args: server.args,
            ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
          }
    return [`mcp_servers.${server.name}`, fields]
  })
  return { config: Object.fromEntries(entries) }
}
