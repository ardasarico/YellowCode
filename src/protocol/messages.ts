import { z } from "zod"

function withUnknown<T extends z.ZodType>(known: T, knownTypes: readonly string[]) {
  return z.union([
    known,
    z
      .looseObject({ type: z.string() })
      .refine((value) => !knownTypes.includes(value.type))
      .transform((value) => ({ type: "unknown" as const, originalType: value.type })),
  ])
}

const textBlock = z.looseObject({ type: z.literal("text"), text: z.string() })
const toolUseBlock = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})
const thinkingBlock = z.looseObject({ type: z.literal("thinking"), thinking: z.string() })
const imageBlock = z.looseObject({
  type: z.literal("image"),
  source: z.looseObject({ type: z.string(), media_type: z.string().optional(), data: z.string().optional() }),
})
const toolResultBlock = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))]).optional(),
  is_error: z.boolean().optional(),
})

export const contentBlock = withUnknown(z.discriminatedUnion("type", [textBlock, toolUseBlock, thinkingBlock]), [
  "text",
  "tool_use",
  "thinking",
])
export const userBlock = withUnknown(z.discriminatedUnion("type", [textBlock, imageBlock, toolResultBlock]), [
  "text",
  "image",
  "tool_result",
])

const systemInit = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string(),
  permissionMode: z.string(),
  cwd: z.string(),
  claude_code_version: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string() })),
  skills: z.array(z.string()),
  plugins: z.array(z.looseObject({ name: z.string() })).optional(),
})

const compactBoundary = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("compact_boundary"),
  compact_metadata: z.looseObject({ trigger: z.string() }),
})

const apiRetry = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.number(),
  max_retries: z.number(),
})

const backgroundTasksChanged = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("background_tasks_changed"),
  tasks: z.array(z.looseObject({ task_id: z.string() })),
})

const taskUsage = z.looseObject({ tool_uses: z.number(), duration_ms: z.number() })

const taskStarted = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_started"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
})

const taskProgress = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_progress"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  usage: taskUsage,
})

const taskUpdated = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_updated"),
  task_id: z.string(),
  patch: z.looseObject({ error: z.string().optional() }),
})

const taskNotification = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_notification"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  status: z.enum(["completed", "failed", "stopped"]),
  summary: z.string(),
  usage: taskUsage.optional(),
})

const textDelta = z.looseObject({ type: z.literal("text_delta"), text: z.string() })
const inputJsonDelta = z.looseObject({ type: z.literal("input_json_delta"), partial_json: z.string() })
const thinkingDelta = z.looseObject({ type: z.literal("thinking_delta"), thinking: z.string() })

const streamEvent = z.looseObject({
  type: z.literal("stream_event"),
  parent_tool_use_id: z.string().nullable(),
  event: withUnknown(
    z.discriminatedUnion("type", [
      z.looseObject({ type: z.literal("message_start"), message: z.looseObject({ id: z.string() }) }),
      z.looseObject({ type: z.literal("content_block_start"), index: z.number(), content_block: contentBlock }),
      z.looseObject({
        type: z.literal("content_block_delta"),
        index: z.number(),
        delta: withUnknown(z.discriminatedUnion("type", [textDelta, inputJsonDelta, thinkingDelta]), [
          "text_delta",
          "input_json_delta",
          "thinking_delta",
        ]),
      }),
      z.looseObject({ type: z.literal("content_block_stop"), index: z.number() }),
    ]),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop"],
  ),
})

const assistant = z.looseObject({
  type: z.literal("assistant"),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({ id: z.string(), content: z.array(contentBlock) }),
})

const hunk = z.looseObject({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
})

const user = z.looseObject({
  type: z.literal("user"),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(userBlock)]) }),
  tool_use_result: z
    .union([
      z.looseObject({
        type: z.string().optional(),
        structuredPatch: z.array(hunk).optional(),
        isAsync: z.boolean().optional(),
      }),
      z.unknown().transform(() => undefined),
    ])
    .optional(),
})

const result = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  total_cost_usd: z.number(),
  duration_ms: z.number(),
  usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number() }),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
})

const controlRequest = z.looseObject({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.discriminatedUnion("subtype", [
    z.looseObject({
      subtype: z.literal("can_use_tool"),
      tool_name: z.string(),
      tool_use_id: z.string(),
      input: z.unknown(),
    }),
    z.looseObject({ subtype: z.literal("interrupt") }),
  ]),
})

const controlResponse = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.string(),
    response: z.looseObject({ behavior: z.string().optional() }).optional(),
  }),
})

const rateLimit = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({ status: z.string() }),
})

const system = z.discriminatedUnion("subtype", [
  systemInit,
  compactBoundary,
  apiRetry,
  backgroundTasksChanged,
  taskStarted,
  taskProgress,
  taskUpdated,
  taskNotification,
])

export const protocolMessage = z.discriminatedUnion("type", [
  system,
  streamEvent,
  assistant,
  user,
  result,
  controlRequest,
  controlResponse,
  rateLimit,
])

export type ProtocolMessage = z.infer<typeof protocolMessage>
export type ContentBlock = z.infer<typeof contentBlock>
export type UserBlock = z.infer<typeof userBlock>

export const KNOWN_KEYS = new Set([
  "system/init",
  "system/compact_boundary",
  "system/api_retry",
  "system/background_tasks_changed",
  "system/task_started",
  "system/task_progress",
  "system/task_updated",
  "system/task_notification",
  "stream_event",
  "assistant",
  "user",
  "result",
  "control_request/can_use_tool",
  "control_request/interrupt",
  "control_response",
  "rate_limit_event",
])
