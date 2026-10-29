// The `/api/event` frames YellowCode reads, each type with its own data schema. A type not listed here is unknown
// (seen and logged once); a listed type whose data does not fit is unreadable. Later stages add the types they
// record.
import { z } from "zod"
import { log } from "../../../log/log.ts"
import { form, permissionRequest } from "./asks.ts"
import { envelope, location } from "./envelope.ts"
import { modelRef, revert, structuredError, tokens } from "./session.ts"

const any = z.looseObject({})
const inSession = <S extends z.ZodRawShape>(shape: S) => z.looseObject({ sessionID: z.string(), ...shape })
const inMessage = <S extends z.ZodRawShape>(shape: S) => inSession({ assistantMessageID: z.string(), ...shape })
const part = <S extends z.ZodRawShape>(shape: S) => inMessage({ ordinal: z.number(), ...shape })
const tool = <S extends z.ZodRawShape>(shape: S) => inMessage({ id: z.string(), ...shape })
const content = z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  envelope.extend({ type: z.literal(type), data })

const events = z.discriminatedUnion("type", [
  event("server.connected", any),
  event("worktree.resolved", z.looseObject({ projectID: z.string(), directory: z.string() })),
  event("project.updated", z.looseObject({ id: z.string() })),
  event("vcs.branch.updated", any),
  ...(
    [
      "config",
      "integration",
      "provider",
      "model",
      "agent",
      "command",
      "skill",
      "websearch",
      "reference",
      "plugin",
    ] as const
  ).map((name) => event(`${name}.updated`, any)),
  event("mcp.status.changed", z.looseObject({ server: z.string() })),
  event(
    "session.created",
    inSession({ projectID: z.string(), location, title: z.string().optional(), slug: z.string().optional() }),
  ),
  event("session.renamed", inSession({ title: z.string() })),
  // `sessionID` is the copy, `parentID` the session it was copied from.
  event("session.forked", inSession({ parentID: z.string() })),
  event(
    "session.inbox.enqueued",
    inSession({
      inboxID: z.string(),
      item: z.looseObject({ type: z.string(), payload: z.unknown(), delivery: z.string().optional() }),
    }),
  ),
  event("session.inbox.delivered", inSession({ inboxID: z.string() })),
  event("session.inbox.cancelled", inSession({ inboxID: z.string() })),
  event("session.execution.started", inSession({})),
  event("session.execution.succeeded", inSession({})),
  event("session.execution.failed", inSession({ error: structuredError })),
  event("session.execution.interrupted", inSession({ reason: z.string() })),
  event("session.deleted", inSession({})),
  event("session.revert.staged", inSession({ revert })),
  event("session.revert.cleared", inSession({})),
  // `to` is the prompt the conversation now ends before.
  event("session.revert.committed", inSession({ to: z.string() })),
  // `previous` is missing when the session had no agent of its own yet.
  event("session.agent.selected", inSession({ agent: z.string(), previous: z.string().optional() })),
  // `variant` is missing, or "default", while none is picked.
  event("session.model.selected", inSession({ model: modelRef, previous: modelRef.optional() })),
  event("session.instructions.updated", inSession({})),
  event("session.usage.updated", inSession({ cost: z.number(), tokens })),
  event(
    "session.step.started",
    inMessage({ agent: z.string(), model: modelRef, snapshot: z.string().optional(), started: z.number().optional() }),
  ),
  event("session.step.streamed", inMessage({})),
  // `attempt` is the try that comes next, so the first retry is attempt 2; `at` is when it starts.
  event("session.retry.scheduled", inMessage({ attempt: z.number(), at: z.number(), error: structuredError })),
  event("session.step.failed", inMessage({ error: structuredError, tokens: tokens.optional() })),
  // `inputID` is the compaction's own message, given only when one was asked for; its end never names it. `tokens` are
  // the summary request's, its output the summary.
  event("session.compaction.started", inSession({ inputID: z.string().optional(), reason: z.string() })),
  event("session.compaction.delta", inSession({})),
  event("session.compaction.ended", inSession({ inputID: z.string().optional(), tokens: tokens.optional() })),
  event("session.compaction.failed", inSession({ inputID: z.string().optional(), error: structuredError })),
  event(
    "session.step.ended",
    inMessage({
      finish: z.string(),
      tokens,
      cost: z.number(),
      snapshot: z.string().optional(),
      files: z.array(z.string()).optional(),
    }),
  ),
  event("session.text.started", part({})),
  event("session.text.delta", part({ delta: z.string() })),
  event("session.text.ended", part({ text: z.string() })),
  event("session.reasoning.started", part({})),
  event("session.reasoning.delta", part({ delta: z.string() })),
  event("session.reasoning.ended", part({ text: z.string() })),
  event("session.tool.input.started", tool({ name: z.string() })),
  event("session.tool.input.delta", tool({ delta: z.string() })),
  event("session.tool.input.ended", tool({ text: z.string() })),
  event("session.tool.called", tool({ input: z.record(z.string(), z.unknown()), executed: z.boolean().optional() })),
  event("session.tool.progress", tool({ metadata: z.record(z.string(), z.unknown()).optional() })),
  event(
    "session.tool.success",
    // Metadata is open per tool; the translator reads `files` and `exit` per tool kind.
    tool({ content, metadata: z.record(z.string(), z.unknown()).optional() }),
  ),
  event("session.tool.failed", tool({ error: structuredError })),
  // `metadata.sessionID` is the session whose call runs the shell; the user's own shells have none.
  event(
    "shell.created",
    z.looseObject({
      info: z.looseObject({
        id: z.string(),
        command: z.string(),
        status: z.string(),
        metadata: z.looseObject({ sessionID: z.string().optional() }).optional(),
      }),
    }),
  ),
  event("shell.exited", z.looseObject({ id: z.string(), exit: z.number().optional(), status: z.string() })),
  event("shell.deleted", z.looseObject({ id: z.string() })),
  event("permission.asked", permissionRequest),
  event("permission.replied", inSession({ requestID: z.string(), reply: z.string() })),
  event("form.created", z.looseObject({ form })),
  event("form.replied", inSession({ id: z.string(), answer: z.record(z.string(), z.unknown()) })),
  event("form.cancelled", inSession({ id: z.string() })),
])

export type OpencodeEvent = z.output<typeof events>

const KNOWN = new Set<string>(events.options.map((option) => option.shape.type.value))

// `at` is when opencode said it: the envelope's `created`, else the last one seen (0 before any), never the clock, so
// a replay gives the same times. `durable` is the envelope's, for unknown and unreadable types too, so the sequence
// of an aggregate can be followed over types YellowCode does not read.
export type Durable = { aggregateID: string; seq: number }
export type ReadEvent = { at: number; durable: Durable | null } & (
  | { kind: "event"; event: OpencodeEvent }
  | { kind: "unknown"; type: string }
  | { kind: "unreadable"; what: string }
)

// Reads frames in order. Unreadable frames are logged with their type only, unknown types once each.
export function createEventReader(): (frame: unknown) => ReadEvent {
  let at = 0
  const unknown = new Set<string>()
  return (frame) => {
    const base = envelope.safeParse(frame)
    if (!base.success) {
      log.warn("opencode: an event frame is unreadable")
      return { at, durable: null, kind: "unreadable", what: "event" }
    }
    at = base.data.created ?? at
    const type = base.data.type
    const durable = base.data.durable
      ? { aggregateID: base.data.durable.aggregateID, seq: base.data.durable.seq }
      : null
    if (!KNOWN.has(type)) {
      if (!unknown.has(type)) log.info(`opencode: unknown event ${type}`)
      unknown.add(type)
      return { at, durable, kind: "unknown", type }
    }
    const parsed = events.safeParse(frame)
    if (parsed.success) return { at, durable, kind: "event", event: parsed.data }
    log.warn(`opencode: a ${type} event is unreadable`)
    return { at, durable, kind: "unreadable", what: type }
  }
}
