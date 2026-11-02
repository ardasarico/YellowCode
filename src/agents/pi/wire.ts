// The parts of pi's RPC output the adapter reads: command responses, session events and extension UI requests. Every
// schema is loose, so fields pi adds later pass through.
import { z } from "zod"

const usage = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.looseObject({ total: z.number() }).optional(),
})
export type Usage = z.output<typeof usage>

const part = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
})
export type Part = z.output<typeof part>

export const message = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(part)]).optional(),
  usage: usage.optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
  timestamp: z.number().optional(),
})
export type Message = z.output<typeof message>

const assistantEvent = z.looseObject({
  type: z.string(),
  contentIndex: z.number().optional(),
  delta: z.string().optional(),
  content: z.string().optional(),
  id: z.string().optional(),
  toolName: z.string().optional(),
  toolCall: z.looseObject({ id: z.string(), name: z.string(), arguments: z.unknown() }).optional(),
})

const toolResult = z.looseObject({
  content: z.array(part).optional(),
  details: z.unknown().optional(),
  structuredContent: z.unknown().optional(),
})
export type ToolResult = z.output<typeof toolResult>

export const event = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("agent_start") }),
  z.looseObject({ type: z.literal("agent_end") }),
  z.looseObject({ type: z.literal("agent_settled"), aborted: z.boolean().optional() }),
  z.looseObject({ type: z.literal("turn_start") }),
  z.looseObject({ type: z.literal("turn_end") }),
  z.looseObject({ type: z.literal("message_start"), message }),
  z.looseObject({ type: z.literal("message_end"), message }),
  z.looseObject({ type: z.literal("message_update"), assistantMessageEvent: assistantEvent }),
  z.looseObject({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    partialResult: toolResult.optional(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: toolResult.optional(),
    isError: z.boolean().optional(),
  }),
  z.looseObject({ type: z.literal("queue_update") }),
  z.looseObject({
    type: z.literal("auto_retry_start"),
    attempt: z.number(),
    maxAttempts: z.number().optional(),
    delayMs: z.number().optional(),
    errorMessage: z.string().optional(),
  }),
  z.looseObject({ type: z.literal("auto_retry_end") }),
  z.looseObject({ type: z.literal("compaction_start") }),
  z.looseObject({ type: z.literal("compaction_end"), aborted: z.boolean().optional() }),
  z.looseObject({ type: z.literal("session_info_changed"), name: z.string().optional() }),
  z.looseObject({ type: z.literal("thinking_level_changed"), level: z.string() }),
  z.looseObject({
    type: z.literal("extension_error"),
    extensionPath: z.string().optional(),
    error: z.string().optional(),
  }),
  z.looseObject({ type: z.literal("extension_ui_request"), id: z.string(), method: z.string() }),
])
export type PiEvent = z.output<typeof event>

export const response = z.looseObject({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
})

// get_state, with only the fields YellowCode keeps. A model's baseUrl, headers and keys are never kept.
export const state = z.looseObject({
  model: z
    .looseObject({
      id: z.string(),
      name: z.string().optional(),
      provider: z.string(),
      contextWindow: z.number().optional(),
    })
    .nullable()
    .optional(),
  thinkingLevel: z.string().optional(),
  isStreaming: z.boolean().optional(),
  sessionId: z.string(),
  sessionFile: z.string().optional(),
  sessionName: z.string().optional(),
})
export type State = {
  model: { id: string; name: string; provider: string; contextWindow: number | null } | null
  sessionId: string
  sessionName: string | null
  thinking: string | null
}

export function stateOf(data: unknown): State | null {
  const parsed = state.safeParse(data)
  if (!parsed.success) return null
  const model = parsed.data.model
  return {
    model: model
      ? {
          id: model.id,
          name: model.name ?? model.id,
          provider: model.provider,
          contextWindow: model.contextWindow ?? null,
        }
      : null,
    sessionId: parsed.data.sessionId,
    sessionName: parsed.data.sessionName ?? null,
    thinking: parsed.data.thinkingLevel ?? null,
  }
}

export const commands = z.looseObject({
  commands: z.array(
    z.looseObject({ name: z.string(), description: z.string().optional(), source: z.string().optional() }),
  ),
})

export const promptReply = z.looseObject({ disposition: z.string().optional() })

export const clearedQueue = z.looseObject({ steering: z.array(z.string()), followUp: z.array(z.string()) })

export const forkMessages = z.looseObject({
  messages: z.array(z.looseObject({ entryId: z.string(), text: z.string() })),
})

export const forked = z.looseObject({ text: z.string().optional(), cancelled: z.boolean().optional() })

export const levels = z.looseObject({ levels: z.array(z.string()) })

export const stats = z.looseObject({
  sessionFile: z.string().optional(),
  cost: z.number().optional(),
  contextUsage: z
    .looseObject({ tokens: z.number().nullable().optional(), contextWindow: z.number().optional() })
    .optional(),
})
