// The shapes every opencode answer and event share. Objects are loose: fields opencode adds later pass through.
import { z } from "zod"
import { log } from "../../../log/log.ts"
import type { Reply } from "../transport.ts"

export const location = z.looseObject({ directory: z.string() })

// `{_tag, message}`; a 401 has only the tag.
export const apiError = z.looseObject({ _tag: z.string(), message: z.string().optional() })

export const dataOf = <T extends z.ZodType>(schema: T) => z.looseObject({ data: schema })

export const cursor = z.looseObject({
  previous: z.string().nullable().optional(),
  next: z.string().nullable().optional(),
})

export const pageOf = <T extends z.ZodType>(row: T) => z.looseObject({ data: z.array(row), cursor })

// A list whose rows are read one by one with `rowsOf`.
export const rawPage = z.looseObject({ data: z.array(z.unknown()), cursor })

const unfit = new Set<string>()

// Each row on its own, so one that does not fit (a new enum value in a known type) is skipped, not the whole list.
// Logged once per kind of row and type.
export function rowsOf<T extends z.ZodType>(items: unknown[], schema: T, what: string): z.output<T>[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item)
    if (parsed.success) return [parsed.data]
    const type = z.looseObject({ type: z.string() }).safeParse(item).data?.type
    const key = type === undefined ? what : `${what} ${type}`
    if (!unfit.has(key)) log.warn(`opencode: a ${key} is unreadable`)
    unfit.add(key)
    return []
  })
}

// One `/api/event` frame. `created` is missing on `server.connected`; `durable` marks events kept in the session log.
export const envelope = z.looseObject({
  id: z.string(),
  created: z.number().optional(),
  type: z.string(),
  location: location.optional(),
  data: z.unknown(),
  durable: z.looseObject({ aggregateID: z.string(), seq: z.number(), version: z.number() }).optional(),
})

export type Answer<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; status: number; tag: string; message: string | null }
  | { kind: "unreadable"; what: string }

// A reply read with `schema` when it succeeded, as opencode's error when it did not. 204 bodies are undefined.
export function answerOf<T extends z.ZodType>(reply: Reply, schema: T, what: string): Answer<z.output<T>> {
  if (reply.status >= 200 && reply.status < 300) {
    const parsed = schema.safeParse(reply.body)
    return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "unreadable", what }
  }
  const error = apiError.safeParse(reply.body)
  if (!error.success) return { kind: "error", status: reply.status, tag: "", message: null }
  const { _tag: tag, message } = error.data
  return { kind: "error", status: reply.status, tag, message: message ?? null }
}
