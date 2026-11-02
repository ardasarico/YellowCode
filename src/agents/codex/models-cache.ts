// Codex's own copy of its model catalog, the one place that names a model's context window before a turn. Only that
// field is read, by slug; the file's shape is Codex's to change, so anything unexpected reads as no window.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { ModelGroup } from "../../agent/lists.ts"
import { parseJson } from "../../json.ts"

const cache = z.looseObject({ models: z.array(z.unknown()) })
const entry = z.looseObject({ slug: z.string(), context_window: z.number().int().positive() })

export const cacheFile = (env: Record<string, string | undefined> = process.env) =>
  join(env["CODEX_HOME"] || join(homedir(), ".codex"), "models_cache.json")

export function cachedWindows(file = cacheFile()): Map<string, number> {
  const windows = new Map<string, number>()
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return windows
  }
  const json = parseJson(text)
  const parsed = json.ok ? cache.safeParse(json.value) : null
  for (const one of parsed?.success ? parsed.data.models : []) {
    const row = entry.safeParse(one)
    if (row.success) windows.set(row.data.slug, row.data.context_window)
  }
  return windows
}

export const withWindows = (groups: ModelGroup[], windows: Map<string, number>): ModelGroup[] =>
  groups.map((group) => ({
    ...group,
    models: group.models.map((row) => ({ ...row, window: row.window ?? windows.get(row.ref.id) ?? null })),
  }))
