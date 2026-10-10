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
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string(), error: z.string().optional() })),
  skills: z.array(z.string()),
  apiKeySource: z.string().optional(),
  plugins: z.array(z.looseObject({ name: z.string() })).optional(),
  slash_commands: z.array(z.string()).optional(),
  terminal_slash_commands: z.array(z.string()).optional(),
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
  message: z.looseObject({
    id: z.string(),
    content: z.array(contentBlock),
    usage: z
      .looseObject({
        input_tokens: z.number(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
      })
      .optional(),
  }),
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
  usage: z.looseObject({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }),
  modelUsage: z.record(z.string(), z.looseObject({ contextWindow: z.number() })).optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
})

const permissionUpdate = z.looseObject({
  type: z.string(),
  rules: z.array(z.looseObject({ toolName: z.string(), ruleContent: z.string().optional() })).optional(),
  behavior: z.string().optional(),
  mode: z.string().optional(),
  directories: z.array(z.string()).optional(),
  destination: z.string().optional(),
})

export const askUserQuestionInput = z.looseObject({
  questions: z.array(
    z.looseObject({
      question: z.string(),
      header: z.string(),
      options: z.array(
        z.looseObject({ label: z.string(), description: z.string().optional(), preview: z.string().optional() }),
      ),
      multiSelect: z.boolean().optional(),
    }),
  ),
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
      description: z.string().optional(),
      display_name: z.string().optional(),
      decision_reason: z.string().optional(),
      decision_reason_type: z.string().optional(),
      permission_suggestions: z.array(permissionUpdate).optional(),
      default_to_no: z.boolean().optional(),
      suppress_always_allow_rule: z.boolean().optional(),
      blocked_path: z.string().optional(),
    }),
    z.looseObject({ subtype: z.literal("interrupt") }),
  ]),
})

const controlResponse = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.string(),
    response: z
      .looseObject({
        behavior: z.string().optional(),
        message: z.string().optional(),
        updatedInput: z
          .looseObject({
            answers: z.record(z.string(), z.string()).optional(),
            annotations: z.record(z.string(), z.looseObject({ notes: z.string().optional() })).optional(),
          })
          .optional(),
      })
      .optional(),
  }),
})

export const slashCommand = z.looseObject({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
  aliases: z.array(z.string()).optional(),
  builtin: z.boolean().optional(),
})

export const initializeResponse = z.looseObject({ commands: z.array(slashCommand) })

export const modelInfo = z.looseObject({ value: z.string(), description: z.string().optional() })

export const initializeModels = z.looseObject({ models: z.array(modelInfo) })

const limitWindow = z.looseObject({ utilization: z.number(), resetsAt: z.number() })

const rateLimit = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({
    status: z.string(),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
    utilization: z.number().optional(),
    unifiedWindows: z.looseObject({ five_hour: limitWindow.optional(), seven_day: limitWindow.optional() }).optional(),
  }),
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
export type PermissionUpdate = z.infer<typeof permissionUpdate>
export type AskUserQuestionInput = z.infer<typeof askUserQuestionInput>
export type SlashCommand = z.infer<typeof slashCommand>
export type InitializeResponse = z.infer<typeof initializeResponse>
export type ModelInfo = z.infer<typeof modelInfo>

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
