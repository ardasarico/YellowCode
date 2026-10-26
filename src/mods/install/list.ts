import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import { parseJson } from "../../protocol/json.ts"
import { MOD_ID } from "../manifest.ts"

const LIST_URL = "https://raw.githubusercontent.com/ardasarico/YellowCode/main/mods.json"

export const REPO = /^[\w.-]+\/[\w.-]+$/
export const SHA = /^[0-9a-f]{40}$/

const ListedMod = z.object({
  id: z.string().regex(MOD_ID, "must be lowercase words joined by -"),
  name: z.string().min(1),
  description: z.string(),
  repo: z.string().regex(REPO, "must be owner/repo"),
  version: z.string().min(1),
  sha: z.string().regex(SHA, "must be a full 40-character commit SHA"),
  treeHash: z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/, "must be sha256-<base64>"),
  api: z.string().min(1),
})

const Revoked = z.object({
  id: z.string().regex(MOD_ID, "must be lowercase words joined by -"),
  versions: z.union([z.array(z.string()), z.literal("all")]),
  shas: z.array(z.string().regex(SHA, "must be a full 40-character commit SHA")).optional(),
  reason: z.string().min(1),
})

const ModList = z.object({ mods: z.array(ListedMod), revoked: z.array(Revoked) }).superRefine((list, context) => {
  const seen = new Set<string>()
  for (const [index, mod] of list.mods.entries()) {
    if (seen.has(mod.id)) context.addIssue({ code: "custom", path: ["mods", index, "id"], message: "is listed twice" })
    seen.add(mod.id)
  }
})

export type ListedMod = z.output<typeof ListedMod>
export type ModList = z.output<typeof ModList>
export type ListResult = { ok: true; list: ModList } | { ok: false; problem: string }

export function parseList(value: unknown): ListResult {
  const parsed = ModList.safeParse(value)
  if (parsed.success) return { ok: true, list: parsed.data }
  const issue = parsed.error.issues[0]
  const path = issue?.path.join(".") || "list"
  return { ok: false, problem: `mods.json: ${path}: ${issue?.message ?? "invalid"}` }
}

export async function fetchList(): Promise<ListResult> {
  const url = process.env["YELLOWCODE_MOD_LIST"] ?? LIST_URL
  let text: string
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return { ok: false, problem: `mod list: HTTP ${response.status}` }
    text = await response.text()
  } catch (error) {
    return { ok: false, problem: `mod list: ${error instanceof Error ? error.message : String(error)}` }
  }
  const json = parseJson(text)
  if (!json.ok) return { ok: false, problem: "mods.json is not valid JSON" }
  return parseList(json.value)
}

// Fetches the list and caches it when that worked.
export async function refreshList(now = Date.now()): Promise<ListResult> {
  const fetched = await fetchList()
  if (fetched.ok) writeCachedList(fetched.list, now)
  return fetched
}

function cacheFile(): string {
  const base = process.env["XDG_CACHE_HOME"]
  return join(base && isAbsolute(base) ? base : join(homedir(), ".cache"), "yellowcode", "mods.json")
}

const CachedList = z.object({ fetchedAt: z.number(), list: ModList })

export type CachedList = z.output<typeof CachedList>

export function readCachedList(): CachedList | null {
  let text: string
  try {
    text = readFileSync(cacheFile(), "utf8")
  } catch {
    return null
  }
  const json = parseJson(text)
  if (!json.ok) return null
  const parsed = CachedList.safeParse(json.value)
  return parsed.success ? parsed.data : null
}

export function writeCachedList(list: ModList, fetchedAt = Date.now()): void {
  const path = cacheFile()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify({ fetchedAt, list }, null, 2))
  renameSync(`${path}.tmp`, path)
}
