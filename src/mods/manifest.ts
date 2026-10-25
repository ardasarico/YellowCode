import { readFileSync } from "node:fs"
import { basename, isAbsolute, join, normalize } from "node:path"
import { z } from "zod"
import packageJson from "../../package.json"
import { parseJson } from "../protocol/json.ts"

export const MANIFEST = "yellowcode-mod.json"

const Manifest = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  yellowcode: z.string().min(1),
  entry: z.string().regex(/\.tsx?$/),
  // Process or remote MCP servers in the .mcp.json shape, given to Claude while the mod is on.
  mcpServers: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.looseObject({})).optional(),
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

export function compatible(manifest: Manifest, version = packageJson.version): boolean {
  try {
    return Bun.semver.satisfies(version, manifest.yellowcode)
  } catch {
    return false
  }
}
