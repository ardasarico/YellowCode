// Threads, turns and the replies that carry them. Loose objects: fields Codex adds later pass through.
import { z } from "zod"
import { threadItem } from "./items.ts"
import { activeProfile, collaborationMode } from "./settings.ts"

const nullish = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

export const initializeResult = z.looseObject({
  // "<client name>/<codex version> (<os>) <terminal>".
  userAgent: z.string(),
  codexHome: z.string(),
  platformFamily: z.string().optional(),
  platformOs: z.string().optional(),
})

// notLoaded, idle, systemError, or active with flags such as waitingOnApproval.
export const threadStatus = z.looseObject({ type: z.string(), activeFlags: z.array(z.string()).optional() })

export const turnError = z.looseObject({
  message: z.string(),
  codexErrorInfo: z.unknown().optional(),
  additionalDetails: nullish(z.string()),
})

export const turn = z.looseObject({
  id: z.string(),
  // A subagent's turn names the turn of the main thread that led to it.
  rootTurnId: nullish(z.string()),
  // Empty unless the reply loads them (thread/resume, thread/read, turns lists).
  items: z.array(threadItem),
  // completed, interrupted, failed or inProgress.
  status: z.string(),
  error: nullish(turnError),
  startedAt: nullish(z.number()),
  completedAt: nullish(z.number()),
  durationMs: nullish(z.number()),
})

// Times are in seconds. `parentThreadId` is set on a subagent's thread.
export const thread = z.looseObject({
  id: z.string(),
  sessionId: z.string().optional(),
  forkedFromId: nullish(z.string()),
  parentThreadId: nullish(z.string()),
  preview: z.string(),
  name: nullish(z.string()),
  ephemeral: z.boolean().optional(),
  historyMode: z.string().optional(),
  modelProvider: z.string().optional(),
  model: nullish(z.string()),
  reasoningEffort: nullish(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: threadStatus,
  cwd: z.string(),
  cliVersion: z.string().optional(),
  gitInfo: nullish(z.looseObject({ branch: nullish(z.string()) })),
  turns: z.array(turn),
})

// thread/start, thread/resume and thread/fork reply alike.
export const threadStartResult = z.looseObject({
  thread,
  model: z.string(),
  modelProvider: z.string(),
  cwd: z.string(),
  approvalPolicy: z.unknown(),
  sandbox: z.unknown(),
  activePermissionProfile: nullish(activeProfile),
  reasoningEffort: nullish(z.string()),
  // thread/resume only.
  collaborationMode: nullish(collaborationMode),
})

export const turnStartResult = z.looseObject({ turn })

// Only whether someone is signed in is kept: the account is read as its type alone, so an email or plan never
// passes this parse. Only a ChatGPT sign-in has usage limits to read.
export const accountResult = z
  .looseObject({ account: z.object({ type: z.string() }).nullable(), requiresOpenaiAuth: z.boolean() })
  .transform((reply) => ({
    signedIn: reply.account !== null || !reply.requiresOpenaiAuth,
    limited: reply.account?.type === "chatgpt",
  }))

const tokens = z.looseObject({ totalTokens: z.number(), inputTokens: z.number(), outputTokens: z.number() })

// `total` counts the whole thread, `last` the latest request, or after a compaction what the context holds.
export const tokenUsage = z.looseObject({ total: tokens, last: tokens, modelContextWindow: nullish(z.number()) })

// `usedPercent` 0 to 100, `resetsAt` in seconds.
const limitWindow = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: nullish(z.number()),
  resetsAt: nullish(z.number()),
})

// One metered limit; "codex" is the account's own, others name a model's.
export const rateLimits = z.looseObject({
  limitId: nullish(z.string()),
  limitName: nullish(z.string()),
  primary: nullish(limitWindow),
  secondary: nullish(limitWindow),
  rateLimitReachedType: nullish(z.string()),
})

export const rateLimitsResult = z.looseObject({
  rateLimits,
  rateLimitsByLimitId: nullish(z.record(z.string(), rateLimits)),
})

export type TokenUsage = z.output<typeof tokenUsage>
export type RateLimits = z.output<typeof rateLimits>

// thread/list and thread/turns/list: rows are read one at a time, so one Codex cannot read leaves the rest.
export const page = z.looseObject({ data: z.array(z.unknown()), nextCursor: z.string().nullable() })

export type Thread = z.output<typeof thread>
export type Turn = z.output<typeof turn>
export type TurnError = z.output<typeof turnError>

export type Result<T> = { kind: "ok"; value: T } | { kind: "unreadable"; what: string }

// A reply read with `schema`; one that does not fit is unreadable under the method's name.
export function resultOf<T extends z.ZodType>(value: unknown, schema: T, what: string): Result<z.output<T>> {
  const parsed = schema.safeParse(value)
  return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "unreadable", what }
}

export const turnSteerResult = z.looseObject({ turnId: z.string() })

// thread/queue/list: what waits to run after the turn, oldest first.
export const queuePage = z.looseObject({
  data: z.array(z.looseObject({ id: z.string(), clientUserMessageId: z.string() })),
  nextCursor: z.string().nullable(),
})

export const queueDeleted = z.looseObject({ deleted: z.boolean() })

export const terminalsPage = z.looseObject({
  data: z.array(z.looseObject({ itemId: z.string(), processId: z.string(), command: z.string() })),
  nextCursor: z.string().nullable(),
})

export const terminateResult = z.looseObject({ terminated: z.boolean() })
export type ThreadStart = z.output<typeof threadStartResult>
