import type { z } from "zod"

export type JsonResult = { ok: true; value: unknown } | { ok: false; error: string }

export function parseJson(text: string): JsonResult {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Row by row, so one odd row does not empty the list.
export function rowsOf<T extends z.ZodType>(
  schema: T,
  rows: readonly unknown[],
): { rows: z.output<T>[]; dropped: number } {
  const kept = rows.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
  return { rows: kept, dropped: rows.length - kept.length }
}
