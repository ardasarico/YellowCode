// Pi's models as YellowCode's rows. A model object also carries its endpoint, headers and cost table; only the fields
// below are kept, and the rest is dropped as it is read.
import { z } from "zod"
import type { EffortRow, ModelGroup, ModelRow } from "../../agent/lists.ts"

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
// Pi offers these only to a model whose level map names them.
const OPT_IN = new Set(["xhigh", "max"])

const model = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  provider: z.string(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  contextWindow: z.number().optional(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
})
const models = z.looseObject({ models: z.array(z.unknown()) })

export type PiModel = {
  id: string
  name: string
  provider: string
  levels: string[]
  images: boolean
  contextWindow: number | null
}

export function levelsOf(reasoning: boolean, map: Record<string, string | null> | undefined): string[] {
  if (!reasoning) return []
  return LEVELS.filter((level) => (map && level in map ? map[level] !== null : !OPT_IN.has(level)))
}

export function modelOf(value: unknown): PiModel | null {
  const parsed = model.safeParse(value)
  if (!parsed.success) return null
  const { id, name, provider, reasoning, input, contextWindow, thinkingLevelMap } = parsed.data
  return {
    id,
    name: name ?? id,
    provider,
    levels: levelsOf(reasoning === true, thinkingLevelMap),
    images: input?.includes("image") === true,
    contextWindow: contextWindow ?? null,
  }
}

export function readModels(data: unknown): PiModel[] {
  const parsed = models.safeParse(data)
  return parsed.success ? parsed.data.models.flatMap((one) => modelOf(one) ?? []) : []
}

export const effortRows = (levels: string[]): EffortRow[] => levels.map((level) => ({ id: level, label: level }))

const rowOf = (one: PiModel): ModelRow => ({
  ref: { provider: one.provider, id: one.id },
  label: one.name,
  note: "",
  resolves: null,
  efforts: effortRows(one.levels),
  images: one.images,
})

// One heading per provider, in the order pi lists them.
export function modelGroups(list: PiModel[]): ModelGroup[] {
  const groups = new Map<string, ModelRow[]>()
  for (const one of list) groups.set(one.provider, [...(groups.get(one.provider) ?? []), rowOf(one)])
  return [...groups].map(([provider, rows]) => ({
    provider: { id: provider, name: provider },
    applies: "now",
    models: rows,
  }))
}
