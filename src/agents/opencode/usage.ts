// How full a session's context is, and what its retries are about. A model's window is its `limit.context`, read
// through the allowlist.
import { z } from "zod"
import type { ContextReport } from "../../agent/agent.ts"
import { readAllowed } from "./allow.ts"
import type { Transport } from "./transport.ts"
import { rowsOf } from "./wire/envelope.ts"

// Context windows by `<provider>/<model>`.
export type Windows = Map<string, number>

export const modelKey = (model: { providerID: string; id: string }) => `${model.providerID}/${model.id}`

const limited = z.looseObject({
  id: z.string(),
  providerID: z.string(),
  limit: z.looseObject({ context: z.number() }).optional(),
})

// Empty when opencode did not list its models.
export async function readWindows(transport: Transport): Promise<Windows> {
  const data = await readAllowed(transport, "/api/model", "the models")
  const rows = rowsOf(Array.isArray(data) ? data : [], limited, "model")
  return new Map(rows.flatMap((row) => (row.limit ? [[modelKey(row), row.limit.context] as const] : [])))
}

const readDefault = async (transport: Transport) =>
  limited.safeParse(await readAllowed(transport, "/api/model/default", "the default model")).data ?? null

// The model a session runs before its first step names one.
export async function defaultModel(transport: Transport): Promise<{ model: string; window: number } | null> {
  const found = await readDefault(transport)
  return found ? { model: modelKey(found), window: found.limit?.context ?? 0 } : null
}

export async function defaultRef(transport: Transport): Promise<{ providerID: string; id: string } | null> {
  const found = await readDefault(transport)
  return found ? { providerID: found.providerID, id: found.id } : null
}

// opencode has no categories, only the total.
export const contextReport = (model: string, used: number, window: number): ContextReport => ({
  model,
  used,
  window,
  categories: [],
  files: [],
  tools: [],
})

// opencode's error types as the retry row's categories; any other reads as unknown. opencode calls a provider's internal
// error with status 503 or 529 overloaded.
const REASONS: Record<string, string> = {
  "provider.rate-limit": "rate_limit",
  "provider.internal": "server_error",
  "provider.auth": "authentication_failed",
}

export function retryReason(type: string, status: number | null): string {
  if (type === "provider.internal" && (status === 503 || status === 529)) return "overloaded"
  return REASONS[type] ?? ""
}
