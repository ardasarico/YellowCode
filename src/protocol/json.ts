export type JsonResult = { ok: true; value: unknown } | { ok: false; error: string }

export function parseJson(text: string): JsonResult {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
