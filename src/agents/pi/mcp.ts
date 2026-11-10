// The MCP servers YellowCode hands pi: registered at start by an extension of ours (mcp-extension.js), which pi
// loads with `-e` from a copy under YellowCode's folder and which reads them from an env variable of pi's process.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { McpLaunch, StartOptions } from "../../agent/agent.ts"
import { parseJson } from "../../json.ts"
import source from "./mcp-extension.js" with { type: "text" }

export const MCP_VAR = "YELLOWCODE_PI_MCP"
const HELD = "yellowcode:mcp-held "

type Held = { name: string; problem: string }

export type PiMcp = {
  flags: string[]
  // What the extension gets; null when it is not loaded.
  extension: { servers: Record<string, unknown>; replace: boolean } | null
  held: Held[]
}

// Our stand-in for pi's own MCP extension (createMcpExtension with our loadConfig) is checked on these versions only.
export function replaces(version: string): boolean {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10))
  return major === 1 && minor !== undefined && minor >= 4
}

// Pi reads `$NAME`, `${NAME}` and a leading `!` in env and header values; ours are already the values themselves.
const literal = (value: string) => value.replaceAll("$", "$$$$").replace(/^!/, "$$!")
const literals = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, literal(value)]))

function configOf(server: McpLaunch): Record<string, unknown> {
  if ("url" in server) return { url: server.url, headers: literals(server.headers) }
  return {
    command: server.command,
    args: server.args,
    env: literals(server.env),
    ...(server.cwd !== undefined && { cwd: server.cwd }),
  }
}

const noSse = (name: string) => `Pi cannot connect to an SSE server, so ${name} is off here.`

// Own list Off takes our stand-in, and with no servers of ours just --no-mcp. A plain start has neither.
export function piMcp(options: Pick<StartOptions, "mcpServers" | "ownMcp" | "plain">, version: string): PiMcp {
  if (options.plain) return { flags: [], extension: null, held: [] }
  const held: Held[] = []
  const servers: Record<string, unknown> = {}
  for (const server of options.mcpServers) {
    if ("url" in server && server.type === "sse") held.push({ name: server.name, problem: noSse(server.name) })
    else servers[server.name] = configOf(server)
  }
  const replace = options.ownMcp?.on === false && replaces(version)
  const flags = replace ? ["--no-mcp"] : []
  const extension = Object.keys(servers).length > 0 ? { servers, replace } : null
  return { flags, extension, held }
}

const reported = z.array(z.object({ name: z.string(), why: z.enum(["own", "refused", "unsupported"]) }))

const PROBLEMS = {
  own: (name: string) => `Pi's own ${name} is used here; remove it from Pi's mcp.json to use the shared one.`,
  refused: (name: string) => `Pi did not take the settings of ${name}, so it is off here.`,
  unsupported: (name: string) => `This Pi cannot take the shared servers, so ${name} is off here.`,
}

// The servers our extension tells of in a notice; null for any other notice.
export function heldIn(message: string): Held[] | null {
  if (!message.startsWith(HELD)) return null
  const json = parseJson(message.slice(HELD.length))
  const list = json.ok ? reported.safeParse(json.value) : null
  return (list?.data ?? []).map(({ name, why }) => ({ name, problem: PROBLEMS[why](name) }))
}

// The extension's copy, written again when this YellowCode has another one.
export function extensionFile(folder: string): string {
  const path = join(folder, "mcp-extension.mjs")
  let now: string | null = null
  try {
    now = readFileSync(path, "utf8")
  } catch {
    // Not written yet.
  }
  if (now === source) return path
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, source, { mode: 0o600 })
  renameSync(temp, path)
  return path
}
