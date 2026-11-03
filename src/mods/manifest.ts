import { readFileSync } from "node:fs"
import { basename, isAbsolute, join, normalize } from "node:path"
import { z } from "zod"
import type { AgentKindId } from "../agent/ids.ts"
import { parseJson } from "../json.ts"
import { apiVersion } from "./version.ts"

export const MANIFEST = "yellowcode-mod.json"
export const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// The agents a mod is made for, or "any" for one that uses no agent-bound API.
export const Agents = z.union([z.literal("any"), z.array(z.string().min(1)).min(1)])

const strings = z.record(z.string(), z.string())

// Only the fields every agent takes: a process with its arguments and environment, or a remote server with its headers.
const McpServer = z.union([
  z.strictObject({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: strings.optional(),
  }),
  z.strictObject({ type: z.enum(["http", "sse"]), url: z.string().min(1), headers: strings.optional() }),
])

export type McpServer = z.output<typeof McpServer>

const Manifest = z.object({
  id: z.string().regex(MOD_ID),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  // A semver range of mod API versions, like "^0.2".
  api: z.string().min(1),
  agents: Agents,
  entry: z.string().regex(/\.tsx?$/),
  // Given to the agent while the mod is on. Tools served by YellowCode itself come from mod.tools.
  mcpServers: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), McpServer).optional(),
})

export type Manifest = z.output<typeof Manifest>

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; problem: string }

export function readManifest(folder: string): ManifestResult {
  let text: string
  try {
    text = readFileSync(join(folder, MANIFEST), "utf8")
  } catch {
    return { ok: false, problem: `no ${MANIFEST}` }
  }
  const json = parseJson(text)
  if (!json.ok) return { ok: false, problem: `${MANIFEST} is not valid JSON` }
  const parsed = Manifest.safeParse(json.value)
  const value = json.value
  const old = typeof value === "object" && value !== null && "yellowcode" in value && !("api" in value)
  if (!parsed.success && old)
    return { ok: false, problem: `${MANIFEST}: "yellowcode" is now "api", like "api": "^0.2"` }
  const noAgents = typeof value === "object" && value !== null && !("agents" in value)
  if (!parsed.success && noAgents && parsed.error.issues.every((issue) => issue.path[0] === "agents"))
    return { ok: false, problem: `${MANIFEST}: needs an "agents" list, like "agents": ["claude"], or "any"` }
  const server = parsed.error?.issues.find((issue) => issue.path[0] === "mcpServers" && issue.path.length > 1)
  if (server)
    return {
      ok: false,
      problem: `${MANIFEST}: mcpServers.${String(server.path[1])} takes command, args and env, or type "http" or "sse" with url and headers`,
    }
  if (parsed.error?.issues.some((issue) => issue.path[0] === "entry"))
    return { ok: false, problem: `${MANIFEST}: "entry" must name a .ts or .tsx file, like "index.tsx"` }
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "manifest"))]
    return { ok: false, problem: `${MANIFEST}: invalid ${fields.join(", ")}` }
  }
  const manifest = parsed.data
  if (manifest.id !== basename(folder))
    return { ok: false, problem: `${MANIFEST}: id "${manifest.id}" is not the folder name "${basename(folder)}"` }
  const entry = normalize(manifest.entry)
  if (isAbsolute(entry) || entry.startsWith(".."))
    return { ok: false, problem: `${MANIFEST}: entry is outside the mod folder` }
  return { ok: true, manifest }
}

export function compatible(manifest: Manifest, version = apiVersion): boolean {
  try {
    return Bun.semver.satisfies(version, manifest.api)
  } catch {
    return false
  }
}

// Which side is behind for an api range that does not match: one that starts above the running API needs a newer
// YellowCode, any other a newer mod.
export function incompatibleText(range: string, version = apiVersion): string {
  const lowest = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range)
  const newerApi = lowest !== null && Bun.semver.order(`${lowest[1]}.${lowest[2] ?? 0}.${lowest[3] ?? 0}`, version) > 0
  return newerApi ? "needs a newer YellowCode · update YellowCode" : "needs a newer version of this mod"
}

export function forAgent(manifest: Pick<Manifest, "agents">, agent: AgentKindId): boolean {
  return manifest.agents === "any" || manifest.agents.includes(agent)
}
