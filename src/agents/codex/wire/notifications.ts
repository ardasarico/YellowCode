// The notifications YellowCode reads, each method with its own params schema. A method not listed here is seen and
// logged once; a listed method whose params do not fit is unreadable, logged with its method only. Later stages add
// the methods they record.
import { z } from "zod"
import { log } from "../../../log/log.ts"
import { fileUpdateChange, threadItem } from "./items.ts"
import { threadSettings } from "./settings.ts"
import { rateLimits, thread, threadStatus, tokenUsage, turn, turnError } from "./thread.ts"

const nullish = <T extends z.ZodType>(schema: T) => schema.nullable().optional()
const inThread = <S extends z.ZodRawShape>(shape: S) => z.looseObject({ threadId: z.string(), ...shape })
const inTurn = <S extends z.ZodRawShape>(shape: S) => inThread({ turnId: z.string(), ...shape })
const ofItem = <S extends z.ZodRawShape>(shape: S) => inTurn({ itemId: z.string(), ...shape })
// What Codex tells the user outside any turn.
const summed = z.looseObject({ summary: z.string(), details: z.string().nullable().optional() })

const note = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ method: z.literal(method), params })

const KNOWN = [
  note("thread/started", z.looseObject({ thread })),
  note("thread/status/changed", inThread({ status: threadStatus })),
  note("turn/started", inThread({ turn })),
  note("turn/completed", inThread({ turn })),
  note("item/started", inTurn({ item: threadItem, startedAtMs: z.number().optional() })),
  note("item/completed", inTurn({ item: threadItem, completedAtMs: z.number().optional() })),
  note("item/agentMessage/delta", ofItem({ delta: z.string() })),
  note("item/reasoning/summaryTextDelta", ofItem({ delta: z.string(), summaryIndex: z.number() })),
  note("item/reasoning/summaryPartAdded", ofItem({ summaryIndex: z.number() })),
  note("item/reasoning/textDelta", ofItem({ delta: z.string(), contentIndex: z.number() })),
  note("item/commandExecution/outputDelta", ofItem({ delta: z.string() })),
  note("item/fileChange/patchUpdated", ofItem({ changes: z.array(fileUpdateChange) })),
  note("item/mcpToolCall/progress", ofItem({ message: z.string() })),
  // The plan item's text so far; the plan is read whole when the item completes.
  note("item/plan/delta", ofItem({ delta: z.string() })),
  note(
    "turn/plan/updated",
    inTurn({
      explanation: z.string().nullable().optional(),
      plan: z.array(z.looseObject({ step: z.string(), status: z.string() })),
    }),
  ),
  note("thread/settings/updated", inThread({ threadSettings })),
  // `willRetry`: Codex tries again on its own; otherwise the turn fails with this error.
  note("error", inTurn({ error: turnError, willRetry: z.boolean() })),
  note("warning", z.looseObject({ threadId: z.string().nullable().optional(), message: z.string() })),
  note("configWarning", summed),
  note("deprecationNotice", summed),
  note("model/rerouted", inTurn({ fromModel: z.string(), toModel: z.string(), reason: z.string() })),
  // The thread's history was cut back, by us or another client; the turns that are left are read again.
  note("thread/reverted", inThread({})),
  // Prompts waiting in the thread's queue changed; the queue is read again to see how.
  note("thread/queue/changed", inThread({})),
  note("thread/tokenUsage/updated", inTurn({ tokenUsage })),
  // The account's limits; a window or the reached type that is null was not sent this time.
  note("account/rateLimits/updated", z.looseObject({ rateLimits })),
  note("thread/name/updated", inThread({ threadName: nullish(z.string()) })),
  // Deprecated for the contextCompaction item, which tells the same.
  note("thread/compacted", inTurn({})),
  // Codex no longer waits for an answer to one of its requests.
  note("serverRequest/resolved", inThread({ requestId: z.union([z.number(), z.string()]) })),
] as const

const notification = z.discriminatedUnion("method", KNOWN)
const METHODS: ReadonlySet<string> = new Set(KNOWN.map((schema) => schema.shape.method.value))

export type Notification = z.output<typeof notification>

export type ReadNotification =
  | { kind: "notification"; at: number | null; notification: Notification }
  | { kind: "seen"; at: number | null; method: string }
  | { kind: "unreadable"; at: number | null; what: string }

export function createNotificationReader(): (method: string, params: unknown, at: number | null) => ReadNotification {
  const logged = new Set<string>()
  const once = (key: string, write: () => void) => {
    if (!logged.has(key)) write()
    logged.add(key)
  }
  return (method, params, at) => {
    if (!METHODS.has(method)) {
      once(`seen ${method}`, () => log.info(`codex: ${method} is not read yet`))
      return { kind: "seen", at, method }
    }
    const parsed = notification.safeParse({ method, params })
    if (parsed.success) return { kind: "notification", at, notification: parsed.data }
    once(`unreadable ${method}`, () => log.warn(`codex: a ${method} is unreadable`))
    return { kind: "unreadable", at, what: method }
  }
}
