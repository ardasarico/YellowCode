// The models each provider listed last, kept in ~/.yellowcode/models.json. Only the fields below are kept: an agent's
// raw rows can carry endpoints, headers and keys.
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import type { AgentKindId } from "../agent/ids.ts"
import type { ModelGroup, ModelRow } from "../agent/lists.ts"
import { dataPath } from "../config-path.ts"
import { parseJson } from "../json.ts"
import { writeBeside } from "../rewind/common.ts"

const effort = z.object({
  id: z.string(),
  label: z.string(),
  note: z.string().optional(),
  message: z.string().optional(),
})

const row = z.object({
  ref: z.object({ provider: z.string().nullable(), id: z.string() }),
  label: z.string(),
  note: z.string(),
  resolves: z.string().nullable(),
  efforts: z.array(effort),
  images: z.boolean(),
  window: z.number().nullable(),
})

const group = z.object({
  provider: z.object({ id: z.string(), name: z.string() }).nullable(),
  applies: z.enum(["now", "new-session"]),
  models: z.array(row),
})

const listed = z.object({ version: z.string(), at: z.number(), groups: z.array(group) })

const catalog = z.object({ version: z.literal(1), providers: z.record(z.string(), listed) })

export type Listed = { version: string; at: number; groups: ModelGroup[] }
export type Catalog = { version: 1; providers: Record<AgentKindId, Listed> }

export const catalogFile = () => dataPath("models.json")

const empty = (): Catalog => ({ version: 1, providers: {} })

export function readCatalog(file = catalogFile()): Catalog {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return empty()
  }
  const json = parseJson(text)
  const parsed = json.ok ? catalog.safeParse(json.value) : null
  return parsed?.success ? parsed.data : empty()
}

export function writeCatalog(value: Catalog, file = catalogFile()): void {
  const bytes = new TextEncoder().encode(JSON.stringify(catalog.parse(value)))
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = writeBeside(file, bytes, 0o600)
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

const sameRef = (a: ModelRow, b: ModelRow) => a.ref.provider === b.ref.provider && a.ref.id === b.ref.id

// A provider's new list replaces its old one; a window learned before stays on a row whose new list has none.
export function saveListed(provider: AgentKindId, version: string, groups: ModelGroup[], file = catalogFile()): void {
  const now = readCatalog(file)
  const known = now.providers[provider]?.groups.flatMap((one) => one.models) ?? []
  const kept = groups.map((one) => ({
    ...one,
    models: one.models.map((model) =>
      model.window === null ? { ...model, window: known.find((old) => sameRef(old, model))?.window ?? null } : model,
    ),
  }))
  now.providers[provider] = { version, at: Date.now(), groups: kept }
  writeCatalog(now, file)
}

// A window a turn reported for `model`, put on each of the provider's rows that is or stands for it.
export function saveWindow(provider: AgentKindId, model: string, window: number, file = catalogFile()): void {
  const now = readCatalog(file)
  const entry = now.providers[provider]
  if (!entry) return
  let changed = false
  for (const one of entry.groups.flatMap((each) => each.models))
    if ((one.ref.id === model || one.resolves === model) && one.window !== window) {
      one.window = window
      changed = true
    }
  if (changed) writeCatalog(now, file)
}
