import { readFileSync } from "node:fs"
import { basename, isAbsolute, join, normalize } from "node:path"
import { z } from "zod"
import { parseJson } from "../protocol/json.ts"
import { apiVersion } from "./version.ts"

export const MANIFEST = "yellowcode-mod.json"
export const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const Manifest = z.object({
  id: z.string().regex(MOD_ID),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  // A semver range of mod API versions, like "^0.1".
  api: z.string().min(1),
  entry: z.string().regex(/\.tsx?$/),
  // Process or remote MCP servers in the .mcp.json shape, given to Claude while the mod is on.
  // An "sdk" server would be routed to YellowCode itself; mods add those with mod.tools.
  mcpServers: z
    .record(
      z.string().regex(/^[a-zA-Z0-9_-]+$/),
      z.looseObject({}).refine((server) => server.type !== "sdk", "sdk servers come from mod.tools"),
    )
    .optional(),
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
    return { ok: false, problem: `${MANIFEST}: "yellowcode" is now "api", like "api": "^0.1"` }
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
