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
  content: z
    .union([z.string(), z.array(withUnknown(z.discriminatedUnion("type", [textBlock, imageBlock]), ["text", "image"]))])
    .optional(),
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
  mcp_servers: z.array(
    z.looseObject({
      name: z.string(),
      status: z.string(),
      source: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  skills: z.array(z.string()),
  apiKeySource: z.string().optional(),
  plugins: z.array(z.looseObject({ name: z.string(), path: z.string(), source: z.string().optional() })).optional(),
  agents: z.array(z.string()).optional(),
  slash_commands: z.array(z.string()).optional(),
  terminal_slash_commands: z.array(z.string()).optional(),
  // The prompts the turn takes in; none for a turn claude starts by itself.
  user_message_uuids: z.array(z.string()).optional(),
})

const compactBoundary = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("compact_boundary"),
  // post_tokens is the context left after the summary.
  compact_metadata: z.looseObject({
    trigger: z.string(),
    pre_tokens: z.number().optional(),
    post_tokens: z.number().optional(),
  }),
})

// Output of a local command that claude shows as its own text (/usage and others).
const localCommandOutput = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("local_command_output"),
  content: z.string(),
})

// /clear (or a fresh start after plan mode) dropped the conversation; claude goes on in a new session, whose id the
// init right after it carries.
const conversationReset = z.looseObject({ type: z.literal("conversation_reset") })

const apiRetry = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.number(),
  max_retries: z.number(),
  retry_delay_ms: z.number(),
  error_status: z.number().nullable(),
  error: z.string(),
})

const backgroundTasksChanged = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("background_tasks_changed"),
  tasks: z.array(
    z.looseObject({
      task_id: z.string(),
      task_type: z.string().optional(),
      description: z.string().optional(),
      parent_task_id: z.string().optional(),
      ambient: z.boolean().optional(),
    }),
  ),
})

const taskUsage = z.looseObject({ tool_uses: z.number(), duration_ms: z.number(), total_tokens: z.number().optional() })

const taskStarted = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_started"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  description: z.string().optional(),
  task_type: z.string().optional(),
  is_backgrounded: z.boolean().optional(),
  spawn_depth: z.number().optional(),
  parent_task_id: z.string().optional(),
  ambient: z.boolean().optional(),
  prompt: z.string().optional(),
  workflow_name: z.string().optional(),
  subagent_type: z.string().optional(),
})

// Not in the SDK types; observed on local_workflow tasks as full snapshots.
const workflowPhase = z.looseObject({ type: z.literal("workflow_phase"), index: z.number(), title: z.string() })
const workflowAgent = z.looseObject({
  type: z.literal("workflow_agent"),
  index: z.number(),
  label: z.string(),
  phaseIndex: z.number().optional(),
  phaseTitle: z.string().optional(),
  state: z.string(),
  model: z.string().optional(),
  toolCalls: z.number().optional(),
  durationMs: z.number().optional(),
  lastToolName: z.string().optional(),
  lastToolSummary: z.string().optional(),
  resultPreview: z.string().optional(),
  promptPreview: z.string().optional(),
  tokens: z.number().optional(),
  startedAt: z.number().optional(),
})

const taskProgress = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_progress"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  description: z.string().optional(),
  last_tool_name: z.string().optional(),
  usage: taskUsage,
  workflow_progress: z
    .array(z.union([workflowPhase, workflowAgent, z.unknown().transform(() => null)]))
    .optional()
    .catch(undefined),
})

const taskUpdated = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_updated"),
  task_id: z.string(),
  patch: z.looseObject({
    status: z.string().optional(),
    error: z.string().optional(),
    is_backgrounded: z.boolean().optional(),
  }),
})

const taskNotification = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("task_notification"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  status: z.enum(["completed", "failed", "stopped"]),
  summary: z.string(),
  output_file: z.string().optional(),
  usage: taskUsage.optional(),
  // Only a transcript's "killed" sets it: the user stopped the task, and claude will not resume it.
  stopped_by_user: z.boolean().optional(),
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
  uuid: z.string().optional(),
  message: z.looseObject({
    id: z.string(),
    model: z.string().optional(),
    content: z.array(contentBlock),
    usage: z
      .looseObject({
        input_tokens: z.number(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
      })
      .optional(),
  }),
  is_api_error_message: z.boolean().optional(),
  error: z.string().optional(),
  // Set on claude's reply to a local command that failed, such as a compaction the API refused.
  local_command_outcome: z.looseObject({ kind: z.string() }).optional().catch(undefined),
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
  uuid: z.string().optional(),
  // claude's own echo of a local command's output (a model switch, a compaction), not something the user sent. A
  // transcript's prompts carry it too: they ran before this process.
  isReplay: z.boolean().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(userBlock)]) }),
  tool_use_result: z
    .union([
      z.looseObject({
        type: z.string().optional(),
        filePath: z.string().optional(),
        structuredPatch: z.array(hunk).optional(),
        isAsync: z.boolean().optional(),
        agentId: z.string().optional(),
        // The whole file before an Edit or Write; null when the Write made it.
        originalFile: z.string().nullable().optional(),
      }),
      z.unknown().transform(() => undefined),
    ])
    .optional(),
  // Why a tool did not run, per tool use id: "user-rejected" after an interrupt, "permission-rule", …
  tool_result_meta: z
    .array(z.looseObject({ id: z.string(), non_execution_kind: z.string().optional() }))
    .optional()
    .catch(undefined),
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
  user_message_uuids: z.array(z.string()).optional(),
  // Set when a typed command such as /model or /effort ran without the model.
  local_command: z.string().optional(),
})

// Where a user message sent with a uuid is: "queued", "started", "completed".
const commandLifecycle = z.looseObject({
  type: z.literal("command_lifecycle"),
  command_uuid: z.string(),
  state: z.string(),
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

// claude's result for a call the user interrupted.
export const INTERRUPTED_CALL = "The user doesn't want to proceed with this tool use."

// Our own ask reaches the agent as the one tool of an MCP server that YellowCode serves; claude's is an SDK server
// over stdio.
export const OWN_ASK_SERVER = "yellowcode"
export const OWN_ASK = `mcp__${OWN_ASK_SERVER}__ask`

// That server is how the tool gets to claude, not one of the user's servers, so no server list shows it.
export const isOwnAskServer = (server: { name: string; source?: string | null }) =>
  server.name === OWN_ASK_SERVER && server.source === "sdk"

const askPage = z.looseObject({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean().optional(),
  gallery: z.boolean().optional(),
  options: z.array(
    z.looseObject({ label: z.string(), description: z.string().optional(), image: z.string().optional() }),
  ),
})

// Our own ask tool takes either question pages, in stock's shape plus pictures, or one matrix. Counts and repeats
// are checked by ownAskProblem, so the model learns what to fix.
export const ownAskPages = z.looseObject({ questions: z.array(askPage) })
export const ownAskMatrix = z.looseObject({
  matrix: z.looseObject({
    question: z.string(),
    header: z.string(),
    rows: z.array(z.looseObject({ label: z.string() })),
    scale: z.array(z.string()),
  }),
})

const rpcId = z.union([z.string(), z.number()])

// The params of a `tools/call` for our server; claude names the model's tool_use in `_meta`.
export const ownAskCall = z
  .looseObject({
    name: z.string(),
    arguments: z.unknown().optional(),
    _meta: z.looseObject({ "claudecode/toolUseId": z.string().optional() }).optional(),
  })
  .transform(({ name, arguments: input, ...rest }) => ({
    name,
    input,
    toolUseId: rest["_meta"]?.["claudecode/toolUseId"] ?? "",
  }))

// claude gave up a call (an interrupt): `requestId` is the JSON-RPC id of the `tools/call`.
export const mcpCancelled = z.looseObject({ requestId: rpcId })

// Our reply to a `tools/call`, as it goes out in a control_response.
export const ownAskResult = z.looseObject({
  mcp_response: z.looseObject({
    result: z.looseObject({
      content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
      isError: z.boolean().optional(),
    }),
  }),
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
      agent_id: z.string().optional(),
    }),
    z.looseObject({ subtype: z.literal("interrupt") }),
    z.looseObject({ subtype: z.literal("get_task_output"), task_id: z.string() }),
    z.looseObject({ subtype: z.literal("stop_task"), task_id: z.string() }),
    z.looseObject({
      subtype: z.literal("mcp_message"),
      server_name: z.string(),
      message: z.looseObject({
        jsonrpc: z.string().optional(),
        id: rpcId.optional(),
        method: z.string().optional(),
        params: z.unknown().optional(),
      }),
    }),
  ]),
})

// Each request has its own reply shape, so callers parse `response.response` with the schema they need.
const controlResponse = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.string(),
    response: z.unknown().optional(),
  }),
})

// updatedInput is the tool's own input, so only a question's answers in it are read (questionAnswers).
export const permissionReply = z.looseObject({
  behavior: z.string().optional(),
  message: z.string().optional(),
  updatedInput: z.unknown().optional(),
})

export const questionAnswers = z.looseObject({
  answers: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.looseObject({ notes: z.string().optional() })).optional(),
})

// claude takes back one of its own requests, such as a permission ask; it needs no reply.
const controlCancelRequest = z.looseObject({ type: z.literal("control_cancel_request"), request_id: z.string() })

// `reason` says why not: stale_target (not the latest prompt), target_not_found, turn_running.
export const rewindConversationReply = z.looseObject({
  rewound: z.boolean(),
  prefillText: z.string().nullable().optional(),
  precedingAssistantUuid: z.string().nullable().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
})

export const taskOutput = z.looseObject({ output: z.string(), total_bytes: z.number(), truncated: z.boolean() })

export const slashCommand = z.looseObject({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
  aliases: z.array(z.string()).optional(),
  builtin: z.boolean().optional(),
})

export const initializeResponse = z.looseObject({ commands: z.array(slashCommand) })

export const modelInfo = z.looseObject({
  value: z.string(),
  description: z.string().optional(),
  // The full id an alias row stands for, such as claude-opus-5-5 for "opus".
  resolvedModel: z.string().optional(),
})

// What get_settings says the session uses; the reply also holds permission rules and env, so only this is read.
export const appliedSettings = z.looseObject({
  applied: z.looseObject({
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    ultracode: z.boolean().optional(),
    // Asked for, though the model may not have it (then `ultracode` stays false until a model that has it).
    ultracodeRequested: z.boolean().optional(),
  }),
})

// get_context_usage: what fills the context window, by category, with the memory files and MCP tools in it.
export const contextUsage = z.looseObject({
  categories: z.array(
    z.looseObject({ id: z.string().optional(), name: z.string(), tokens: z.number(), kind: z.string() }),
  ),
  totalTokens: z.number(),
  maxTokens: z.number(),
  percentage: z.number(),
  model: z.string(),
  memoryFiles: z.array(z.looseObject({ path: z.string(), tokens: z.number() })).default([]),
  mcpTools: z.array(z.looseObject({ name: z.string(), serverName: z.string(), tokens: z.number() })).default([]),
})

// get_usage: the session's cost, times, changed lines and tokens per model, and the plan.
export const usageReply = z.looseObject({
  session: z.looseObject({
    total_cost_usd: z.number(),
    total_api_duration_ms: z.number(),
    total_duration_ms: z.number(),
    total_lines_added: z.number(),
    total_lines_removed: z.number(),
    model_usage: z.record(
      z.string(),
      z.looseObject({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadInputTokens: z.number(),
        cacheCreationInputTokens: z.number(),
      }),
    ),
  }),
  subscription_type: z.string().nullable().optional(),
})

// get_settings' merged view of claude's settings files, read by the Claude Code rows of /settings.
export const effectiveSettings = z.looseObject({ effective: z.record(z.string(), z.unknown()) })

export const reloadSkillsReply = z.looseObject({ skills: z.array(z.looseObject({ name: z.string() })) })

export const initializeMode = z.looseObject({ current_permission_mode: z.string() })
export const initializeAccount = z.looseObject({ account: z.looseObject({ subscriptionType: z.string() }) })
export const permissionModeReply = z.looseObject({ mode: z.string() })

// Folders end in "/"; paths come as they are, spaces and all.
export const fileSuggestions = z.looseObject({ suggestions: z.array(z.looseObject({ path: z.string() })) })

// Rows are read one by one, so one odd row does not empty the list.
export const commandRows = z.looseObject({ commands: z.array(z.unknown()) })
export const modelRows = z.looseObject({ models: z.array(z.unknown()) })

export const initializeModels = z.looseObject({ models: z.array(modelInfo) })

export const skillRow = z.looseObject({
  name: z.string(),
  display_name: z.string(),
  description: z.string(),
  source: z.string(),
  state: z.string(),
  locked_by: z.string().optional(),
  // Passed back as is with an edit of the skill's state.
  handles: z.unknown().optional(),
})

export const skillsDialog = z.looseObject({ skills: z.array(z.unknown()) })

export const settingsSources = z.looseObject({
  sources: z.array(
    z.looseObject({
      source: z.string(),
      settings: z.looseObject({
        enabledPlugins: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  ),
})

export const pluginHook = z.looseObject({ event: z.string(), matcher: z.string(), pluginName: z.string() })

export const hooksListing = z.looseObject({ hooks: z.array(z.unknown()) })

export const mcpServerRows = z.looseObject({ mcpServers: z.array(z.unknown()) })
// A config can hold keys (env, headers, arguments, a url's query), so it stays unknown until mcp.ts takes the safe
// parts out.
export const mcpServerStatus = z.looseObject({
  name: z.string(),
  status: z.string(),
  error: z.string().nullable().optional(),
  scope: z.string().optional(),
  source: z.string().optional(),
  serverInfo: z.looseObject({ name: z.string(), version: z.string() }).optional().catch(undefined),
  config: z.unknown().optional(),
  tools: z
    .array(z.looseObject({ name: z.string() }))
    .optional()
    .catch(undefined),
})

export const pluginRow = z.looseObject({ name: z.string(), path: z.string(), source: z.string().optional() })
export const reloadPluginsReply = z.looseObject({
  commands: z.array(z.unknown()),
  plugins: z.array(z.unknown()),
  mcpServers: z.array(z.unknown()),
  error_count: z.number().optional(),
})

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

// A heartbeat every 30 s while a tool runs long, such as an open own ask.
const toolProgress = z.looseObject({
  type: z.literal("tool_progress"),
  tool_use_id: z.string(),
  tool_name: z.string(),
  parent_tool_use_id: z.string().nullable().optional(),
})

// claude's state between requests; a turn's first request names the messages it takes in.
const systemStatus = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("status"),
  status: z.string().nullable().optional(),
  user_message_uuids: z.array(z.string()).optional(),
  // Sent when the permission mode changed, e.g. after an always-allow that switches to acceptEdits.
  permissionMode: z.string().optional(),
})

// claude's command list changed (skills reloaded or found in a subfolder); it carries the whole new list.
const commandsChanged = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("commands_changed"),
  commands: z.array(z.unknown()),
})

// The session got a new title, from a rename_session request or a typed /rename.
const sessionTitleChanged = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("session_title_changed"),
  title: z.string(),
})

const system = z.discriminatedUnion("subtype", [
  systemInit,
  systemStatus,
  commandsChanged,
  sessionTitleChanged,
  compactBoundary,
  localCommandOutput,
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
  controlCancelRequest,
  commandLifecycle,
  rateLimit,
  conversationReset,
  toolProgress,
])

export type ProtocolMessage = z.infer<typeof protocolMessage>
export type McpMessage = Extract<
  Extract<ProtocolMessage, { type: "control_request" }>["request"],
  { subtype: "mcp_message" }
>
export type ContentBlock = z.infer<typeof contentBlock>
export type UserBlock = z.infer<typeof userBlock>
export type PermissionUpdate = z.infer<typeof permissionUpdate>
export type AskUserQuestionInput = z.infer<typeof askUserQuestionInput>
export type AskMatrix = z.infer<typeof ownAskMatrix>["matrix"]
export type SlashCommand = z.infer<typeof slashCommand>
export type ModelInfo = z.infer<typeof modelInfo>
export type SkillRow = z.infer<typeof skillRow>
export type SettingsSource = z.infer<typeof settingsSources>["sources"][number]
export type PluginHook = z.infer<typeof pluginHook>

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
  "control_request/get_task_output",
  "control_request/stop_task",
  "control_request/mcp_message",
  "control_response",
  "control_cancel_request",
  "command_lifecycle",
  "system/status",
  "system/commands_changed",
  "system/session_title_changed",
  "system/local_command_output",
  "rate_limit_event",
  "conversation_reset",
  "tool_progress",
])
