// The models each provider listed last, kept in ~/.yellowcode/models.json. Only the fields below are kept: an agent's
// raw rows can carry endpoints, headers and keys.
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import type { AgentKindId } from "../agent/ids.ts"
import type { ModelGroup } from "../agent/lists.ts"
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
