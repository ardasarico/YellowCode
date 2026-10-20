import { basename } from "node:path"
import { createStore, produce } from "solid-js/store"
import { log } from "../log/log.ts"
import {
  OWN_ASK,
  permissionReply,
  questionAnswers,
  taskOutput,
  type ContentBlock,
  type PermissionUpdate,
  type ProtocolMessage,
  type UserBlock,
} from "../protocol/messages.ts"
import { parse, type ParseResult } from "../protocol/parse.ts"
import type { SourceEvent } from "../source/source.ts"
import { LOGIN_HINT, needsLogin } from "./login.ts"
import type { Rewound } from "./rewind.ts"
import { isShell } from "./shells.ts"
import { agentOf, summarizeToolInput } from "./tool-summary.ts"
import type {
  Item,
  ItemId,
  Session,
  SessionEnd,
  SessionInfo,
  Task,
  TaskState,
  ChatImage,
  Thinking,
  ToolCall,
  Window,
  WorkflowProgress,
} from "./types.ts"

export type SessionStore = {
  state: Session
  apply(dir: "in" | "out", parsed: ParseResult, at: number): void
  prepend(events: SourceEvent[]): void
  answer(response: string): void
  stopRunning(): void
  setPermissionMode(mode: string): void
  // The interrupt was refused or timed out, so the turn goes on and may be interrupted again.
  interruptFailed(): void
  // With a problem, Claude Code went away on its own: running work stops and the chat ends with an error row.
  end(problem?: SessionEnd): void
  rewind(rewound: Rewound): void
  redo(): void
}

type Of<T extends ProtocolMessage["type"]> = Extract<ProtocolMessage, { type: T }>
type System<S extends Of<"system">["subtype"]> = Extract<Of<"system">, { subtype: S }>

type Cursor = { messageId: string; blocks: Map<number, ItemId>; lastIndex: number; finalized: Set<number> }

const MAIN = "main"

type ResultContent = Extract<UserBlock, { type: "tool_result" }>["content"]

const MARKERS = ["`", "**", "__", "*", "_"]

// A reply cut off inside `**bold` or a code span would show its opening marker as text.
export function withoutOpenMarkers(markdown: string): string {
  let text = markdown.trimEnd()
  const start = text.lastIndexOf("\n") + 1
  if (/^\s*(```|~~~)/.test(text.slice(start))) return text
  for (const marker of MARKERS) {
    const line = text.slice(start)
    const at = line.lastIndexOf(marker)
    if (at === -1 || line.split(marker).length % 2 === 1) continue
    const before = line[at - 1] ?? " "
    const after = line[at + marker.length] ?? "x"
    const opens = marker === "`" || (!/\s/.test(after) && !(marker.startsWith("_") && /\w/.test(before)))
    if (opens) text = text.slice(0, start + at) + line.slice(at + marker.length)
  }
  return text.trimEnd()
}

function imagesOf(
  blocks: { type: string; source?: { media_type?: string; data?: string } }[],
  name: (index: number) => string,
  path: string | null = null,
): ChatImage[] {
  const sources = blocks.flatMap((block) => (block.type === "image" && block.source?.data ? [block.source] : []))
  return sources.map((source, index) => ({
    name: name(index),
    mediaType: source.media_type ?? "image/png",
    data: source.data ?? null,
    path,
  }))
}

const numbered = (index: number) => `Image ${index + 1}`

function describeUserContent(content: string | UserBlock[]): { text: string; images: ChatImage[] } {
  if (typeof content === "string") return { text: content, images: [] }
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
  return { text, images: imagesOf(content, numbered) }
}

function toolResultText(content: ResultContent): string {
  if (content === undefined) return ""
  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((block) =>
            block.type === "text" ? [block.text] : block.type === "image" ? [] : [`[${block.originalType}]`],
          )
          .join("\n")
  return Bun.stripANSI(text)
}

function toolImages(tool: ToolCall, content: ResultContent): ChatImage[] {
  if (content === undefined || typeof content === "string") return []
  const path = tool.name === "Read" ? readPath(tool.input) : null
  return imagesOf(content, path ? () => basename(path) : numbered, path)
}

function readPath(input: unknown): string | null {
  return typeof input === "object" && input !== null && "file_path" in input && typeof input.file_path === "string"
    ? input.file_path
    : null
}

function firstSuggestion(suggestions: PermissionUpdate[] | undefined): PermissionUpdate | null {
  return suggestions?.find((update) => !(update.type === "setMode" && update.mode === "auto")) ?? null
}

function toolStatus(state: TaskState): ToolCall["status"] {
  if (state === "completed") return "done"
  if (state === "failed") return "error"
  return state
}

// Claude words a Bash step as "Running " plus its description or command, and a description starts with a verb.
function activityOf(message: System<"task_progress">): string {
  const text = message.description ?? ""
  if (message.last_tool_name !== "Bash" || text === "Running command") return text
  return text.replace(/^Running /, "")
}

function workflowOf(items: System<"task_progress">["workflow_progress"], shift: number): WorkflowProgress | null {
  if (!items) return null
  const progress: WorkflowProgress = { phases: [], agents: [] }
  for (const item of items) {
    if (item?.type === "workflow_phase") progress.phases.push({ index: item.index, title: item.title })
    else if (item?.type === "workflow_agent")
      progress.agents.push({
        index: item.index,
        label: item.label,
        phaseIndex: item.phaseIndex ?? null,
        phaseTitle: item.phaseTitle ?? null,
        state: item.state,
        prompt: item.promptPreview ?? "",
        model: item.model ?? null,
        toolCalls: item.toolCalls ?? 0,
        tokens: item.tokens ?? 0,
        durationMs: item.durationMs ?? 0,
        startedAt: item.startedAt === undefined ? null : item.startedAt + shift,
        lastTool: item.lastToolName ?? null,
        lastToolSummary: item.lastToolSummary ?? null,
        result: item.resultPreview ?? null,
      })
  }
  return progress
}

function blankTask(id: string): Task {
  return {
    id,
    type: "",
    toolUseId: null,
    parentId: null,
    depth: 1,
    background: false,
    state: "running",
    name: "",
    description: "",
    prompt: "",
    workflowName: "",
    startedAt: null,
    activity: "",
    lastTool: null,
    toolUses: 0,
    durationMs: 0,
    tokens: 0,
    summary: "",
    outputFile: null,
    error: null,
    workflow: null,
    command: "",
    endedAt: null,
    output: null,
    outputBytes: 0,
    truncated: false,
  }
}

function commandOf(item: Item | undefined): string {
  const input = item?.kind === "tool" ? item.input : undefined
  const command = typeof input === "object" && input !== null && "command" in input ? input.command : undefined
  return typeof command === "string" ? command : ""
}

function notesOf(annotations: Record<string, { notes?: string }> | undefined): Record<string, string> {
  const notes: Record<string, string> = {}
  for (const [question, annotation] of Object.entries(annotations ?? {})) {
    if (annotation.notes) notes[question] = annotation.notes
  }
  return notes
}

export function initInfo(message: System<"init">): SessionInfo {
  return {
    id: message.session_id,
    model: message.model,
    permissionMode: message.permissionMode,
    cwd: message.cwd,
    cliVersion: message.claude_code_version,
    tools: message.tools,
    mcpServers: message.mcp_servers.map((server) => ({
      name: server.name,
      status: server.status,
      source: server.source ?? null,
      scope: null,
      error: server.error ?? null,
      config: null,
      serverInfo: null,
      tools: null,
    })),
    skills: message.skills,
    slashCommands: message.slash_commands ?? [],
    agents: message.agents ?? [],
    plugins: (message.plugins ?? []).map(({ name, path, source }) => ({ name, path, source: source ?? null })),
    apiKeySource: message.apiKeySource ?? "none",
  }
}

export function createSession(options?: { idPrefix?: string; starting?: boolean }): SessionStore {
  const [state, setState] = createStore<Session>({
    info: null,
    status: options?.starting ? "starting" : "idle",
    items: [],
    byId: {},
    tasks: {},
    usage: {
      startedAt: null,
      tokens: 0,
      costUsd: 0,
      context: { used: 0, window: null },
      limits: { fiveHour: null, week: null, models: {} },
      warning: null,
    },
    rewound: null,
    interrupting: false,
    turn: null,
    permissionMode: null,
  })
  const cursors = new Map<string, Cursor>()
  const invalid = new Map<string, { id: ItemId; count: number }>()
  let counter = 0
  let prepends = 0
  let now = 0
  // Recorded times are shifted by this much so a replay reads them as if they happened just now.
  let shift = 0
  // The live background set from the latest background_tasks_changed.
  let live = new Set<string>()
  // Our own get_task_output requests: request id → task id.
  const outputRequests = new Map<string, string>()
  // The request id of the interrupt that is out.
  let interruptId: string | null = null
  // Messages sent during a turn that claude has not taken in yet: uuid → user item.
  const waiting = new Map<string, ItemId>()
  // Shells whose end already has its row; a repeated notification adds no second one.
  const shellEnds = new Set<string>()
  // The live API retry row; it goes once a reply starts or the turn ends.
  let retryId: ItemId | null = null
  let retryAttempt = 0
  // A failed login shows its hint once, after the turn it failed.
  let loginNeeded = false
  let loginShown = false
  // When each streaming thinking block started, so its end can give it a duration.
  const thinkingSince = new Map<ItemId, number>()
  const idPrefix = options?.idPrefix ?? ""
  const newId = (prefix: string): ItemId => `${idPrefix}${prefix}-${++counter}`

  function add(item: Item, parent: string | null | undefined): void {
    setState("byId", item.id, item)
    const parentItem = parent ? state.byId[parent] : undefined
    if (parentItem?.kind === "tool") {
      update(parentItem.id, (tool) => {
        if (tool.kind === "tool") tool.children.push(item.id)
      })
    } else {
      setState(
        "items",
        produce((ids) => {
          ids.push(item.id)
        }),
      )
    }
  }

  function update(id: ItemId, change: (item: Item) => void): void {
    if (state.byId[id]) setState("byId", id, produce(change))
  }

  function dropRetry(): void {
    if (!retryId) return
    const id = retryId
    retryId = null
    setState("items", (ids) => ids.filter((item) => item !== id))
  }

  function onRetry(message: System<"api_retry">): void {
    retryAttempt = message.attempt
    const retry = {
      attempt: message.attempt,
      max: message.max_retries,
      delayMs: message.retry_delay_ms,
      status: message.error_status,
      reason: message.error,
      at: now + shift,
    }
    const text = `API retry ${message.attempt}/${message.max_retries}`
    if (retryId)
      update(retryId, (item) => {
        if (item.kind !== "system") return
        item.text = text
        item.retry = retry
      })
    else {
      retryId = newId("system")
      add({ kind: "system", id: retryId, text, level: "warning", retry }, null)
    }
  }

  function startedItem(block: ContentBlock): Item | null {
    switch (block.type) {
      case "text":
        return { kind: "text", id: newId("text"), markdown: block.text, streaming: true }
      case "thinking":
        return { kind: "thinking", id: newId("thinking"), text: block.thinking, streaming: true, durationMs: null }
      case "tool_use":
        return {
          kind: "tool",
          id: block.id,
          name: block.name,
          inputText: "",
          input: undefined,
          summary: "",
          status: "running",
          result: "",
          children: [],
          patch: null,
          createdFile: false,
          images: [],
          unchanged: false,
          agent: null,
          taskId: null,
        }
      case "unknown":
        return null
      default:
        return null
    }
  }

  function finalize(id: ItemId, block: ContentBlock): void {
    update(id, (item) => {
      if (item.kind === "text" && block.type === "text") {
        item.markdown = block.text
        item.streaming = false
      } else if (item.kind === "thinking" && block.type === "thinking") {
        if (block.thinking) item.text = block.thinking
        endThinking(item)
      } else if (item.kind === "tool" && block.type === "tool_use") {
        item.input = block.input
        item.inputText = JSON.stringify(block.input)
        item.summary = summarizeToolInput(block.input)
        item.agent = agentOf(item.name, block.input)
      }
    })
    const tool = state.byId[id]
    const name = tool?.kind === "tool" ? tool.agent?.name : undefined
    const command = commandOf(tool)
    if (tool?.kind === "tool" && tool.taskId && name) setTask(tool.taskId, (task) => (task.name = name))
    if (tool?.kind === "tool" && tool.taskId && command) setTask(tool.taskId, (task) => (task.command ||= command))
  }

  function endThinking(item: Thinking): void {
    const since = thinkingSince.get(item.id)
    if (item.streaming && since !== undefined) item.durationMs = now - since
    thinkingSince.delete(item.id)
    item.streaming = false
  }

  function stopStreaming(id: ItemId): void {
    update(id, (item) => {
      if (item.kind === "text") item.streaming = false
      else if (item.kind === "thinking") endThinking(item)
    })
  }

  function onStreamEvent(message: Of<"stream_event">): void {
    const key = message.parent_tool_use_id ?? MAIN
    const event = message.event
    switch (event.type) {
      case "message_start":
        dropRetry()
        for (const id of cursors.get(key)?.blocks.values() ?? []) stopStreaming(id)
        cursors.set(key, { messageId: event.message.id, blocks: new Map(), lastIndex: -1, finalized: new Set() })
        return
      case "content_block_start": {
        const cursor = cursors.get(key)
        const item = startedItem(event.content_block)
        if (!cursor || !item) return
        cursor.blocks.set(event.index, item.id)
        cursor.lastIndex = event.index
        if (item.kind === "thinking") thinkingSince.set(item.id, now)
        add(item, message.parent_tool_use_id)
        return
      }
      case "content_block_delta": {
        const id = cursors.get(key)?.blocks.get(event.index)
        const delta = event.delta
        if (!id) return
        if (delta.type === "text_delta") {
          update(id, (item) => {
            if (item.kind === "text") item.markdown += delta.text
          })
        } else if (delta.type === "thinking_delta") {
          update(id, (item) => {
            if (item.kind === "thinking") item.text += delta.thinking
          })
        } else if (delta.type === "input_json_delta") {
          update(id, (item) => {
            if (item.kind === "tool") item.inputText += delta.partial_json
          })
        }
        return
      }
      case "content_block_stop": {
        const id = cursors.get(key)?.blocks.get(event.index)
        if (id) stopStreaming(id)
        return
      }
      case "unknown":
        return
    }
  }

  function onAssistant(message: Of<"assistant">): void {
    // claude repeats an API error as a reply of its own, and the turn's end already shows it.
    if (message.is_api_error_message) {
      const text = message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
      if (needsLogin(message.error, text)) loginNeeded = true
      return
    }
    dropRetry()
    const key = message.parent_tool_use_id ?? MAIN
    const usage = message.message.usage
    // A reply claude makes up itself, such as `/context`, carries no usage.
    if (usage && !message.parent_tool_use_id && message.message.model !== "<synthetic>") {
      setState(
        "usage",
        "context",
        "used",
        usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      )
    }
    const model = message.message.model
    if (message.parent_tool_use_id && model) {
      update(message.parent_tool_use_id, (item) => {
        if (item.kind === "tool" && item.agent && !item.agent.model) item.agent.model = model
      })
    }
    for (const block of message.message.content) {
      if (block.type === "tool_use" && state.byId[block.id]) {
        finalize(block.id, block)
        continue
      }
      const cursor = cursors.get(key)
      const streamable = cursor && cursor.messageId === message.message.id && !cursor.finalized.has(cursor.lastIndex)
      const streamedId = streamable ? cursor.blocks.get(cursor.lastIndex) : undefined
      const streamed = streamedId ? state.byId[streamedId] : undefined
      const sameKind =
        streamed !== undefined &&
        ((streamed.kind === "text" && block.type === "text") ||
          (streamed.kind === "thinking" && block.type === "thinking"))
      if (cursor && streamedId && sameKind) {
        cursor.finalized.add(cursor.lastIndex)
        finalize(streamedId, block)
        continue
      }
      // A blank text block would only add an empty row.
      if (block.type === "text" && !block.text.trim()) continue
      const item = startedItem(block)
      if (!item) continue
      add(item, message.parent_tool_use_id)
      finalize(item.id, block)
      stopStreaming(item.id)
    }
  }

  function onToolResults(message: Of<"user">): void {
    if (message.isReplay || typeof message.message.content === "string") return
    const fileResult = message.tool_use_result
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue
      const tool = state.byId[block.tool_use_id]
      const task = tool?.kind === "tool" && tool.taskId ? state.tasks[tool.taskId] : undefined
      const skipped = message.tool_result_meta?.find((meta) => meta.id === block.tool_use_id)?.non_execution_kind
      update(block.tool_use_id, (item) => {
        if (item.kind !== "tool") return
        // An interrupt stops the tool; claude's rejection text is meant for the model.
        if (skipped === "user-rejected" || skipped === "interrupted") {
          item.status = "stopped"
          item.result = ""
          if (item.agent) item.agent.state = "stopped"
          return
        }
        // A background task's tool result only says it launched; its outcome arrives as a task_notification.
        const launched = !block.is_error && (task?.background === true || fileResult?.isAsync === true)
        if (launched && task) item.status = toolStatus(task.state)
        else item.status = block.is_error ? "error" : "done"
        item.result = toolResultText(block.content)
        item.images = toolImages(item, block.content)
        if (fileResult?.structuredPatch) item.patch = fileResult.structuredPatch
        if (fileResult?.type === "create") item.createdFile = true
        if (fileResult?.type === "file_unchanged") item.unchanged = true
        if (item.agent && !launched) {
          // An agent the user stopped ends with an error result, and it stays stopped.
          if (item.agent.state !== "stopped") item.agent.state = block.is_error ? "failed" : "completed"
          item.agent.report = item.result
        }
      })
    }
  }

  // A tool of the ended turn that never got its result no longer runs, unless it goes on as a background task.
  function settleTurn(): void {
    for (const id of state.items.toReversed()) {
      const item = state.byId[id]
      if (item?.kind === "turn-end") return
      if (item?.kind !== "tool" || item.status !== "running") continue
      if (item.taskId && state.tasks[item.taskId]?.state === "running") continue
      update(id, (tool) => {
        if (tool.kind !== "tool") return
        tool.status = "stopped"
        if (tool.agent?.state === "running") tool.agent.state = "stopped"
      })
    }
  }

  function cutLastText(): void {
    const id = state.items.at(-1)
    const item = id ? state.byId[id] : undefined
    if (!id || item?.kind !== "text") return
    const markdown = withoutOpenMarkers(item.markdown)
    if (!markdown) setState("items", state.items.slice(0, -1))
    else
      update(id, (text) => {
        if (text.kind === "text") text.markdown = markdown
      })
  }

  function onResult(message: Of<"result">): void {
    for (const cursor of cursors.values()) for (const id of cursor.blocks.values()) stopStreaming(id)
    cursors.clear()
    settleTurn()
    const interrupted = state.interrupting
    if (interrupted) cutLastText()
    const errors = message.errors ?? []
    // claude's own diagnostic for a turn that stopped mid-way says nothing the user can act on.
    const stopped =
      message.subtype === "error_during_execution" &&
      !message.result &&
      errors.length > 0 &&
      errors.every((line) => line.startsWith("[ede_diagnostic]"))
    if (stopped) log.info("turn stopped during execution", errors.join("\n"))
    const reason = stopped ? "stopped during execution" : message.result || errors.join("\n") || message.subtype
    // An interrupt ends its turn with an error result, which is no error to the user.
    const error = message.is_error && !interrupted ? reason : null
    const retries = message.is_error && retryId ? retryAttempt : 0
    dropRetry()
    retryAttempt = 0
    add(
      {
        kind: "turn-end",
        id: newId("turn"),
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        error,
        retries,
        interrupted,
        endedAt: now,
      },
      null,
    )
    setState("interrupting", false)
    if (loginNeeded && !loginShown) {
      loginShown = true
      add({ kind: "system", id: newId("system"), text: LOGIN_HINT, level: "warning" }, null)
    }
    loginNeeded = false
    const usage = message.usage
    const window = state.info ? message.modelUsage?.[state.info.model]?.contextWindow : undefined
    setState(
      "usage",
      produce((current) => {
        current.tokens +=
          usage.input_tokens +
          usage.output_tokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
        current.costUsd = message.total_cost_usd
        if (window !== undefined) current.context.window = window
      }),
    )
    for (const uuid of message.user_message_uuids ?? []) settleQueued(uuid)
    setState("turn", null)
    // A message still queued runs next, so the session keeps running.
    setState("status", waiting.size > 0 ? "running" : "idle")
  }

  function settleQueued(uuid: string): void {
    const id = waiting.get(uuid)
    if (!id) return
    waiting.delete(uuid)
    update(id, (item) => {
      if (item.kind === "user") item.queue = null
    })
  }

  function shifted(window: { utilization: number; resetsAt: number }): Window {
    return { utilization: window.utilization, resetsAt: window.resetsAt * 1000 + shift }
  }

  function onRateLimit(message: Of<"rate_limit_event">): void {
    const info = message.rate_limit_info
    const family = info.rateLimitType?.match(/^seven_day_(opus|sonnet)$/)?.[1]
    setState(
      "usage",
      produce((usage) => {
        const windows = info.unifiedWindows
        if (windows?.five_hour) usage.limits.fiveHour = shifted(windows.five_hour)
        if (windows?.seven_day) usage.limits.week = shifted(windows.seven_day)
        if (family && info.utilization !== undefined && info.resetsAt !== undefined) {
          usage.limits.models[family] = shifted({ utilization: info.utilization, resetsAt: info.resetsAt })
        }
        usage.warning =
          info.status === "allowed"
            ? null
            : {
                status: info.status,
                type: info.rateLimitType ?? "",
                resetsAt: info.resetsAt === undefined ? 0 : info.resetsAt * 1000 + shift,
              }
      }),
    )
  }

  function setTask(id: string, change: (task: Task) => void): void {
    if (state.tasks[id]) setState("tasks", id, produce(change))
  }

  function updateTool(task: Task | undefined, change: (tool: ToolCall) => void): void {
    if (task?.toolUseId)
      update(task.toolUseId, (item) => {
        if (item.kind === "tool") change(item)
      })
  }

  // A parent Claude no longer tracks, or never told us about, counts as no parent.
  const knownParent = (id: string | undefined) => (id && state.tasks[id] ? id : null)

  function onTaskStarted(message: System<"task_started">): void {
    if (message.ambient) return
    const tool = message.tool_use_id ? state.byId[message.tool_use_id] : undefined
    const known = state.tasks[message.task_id] ?? blankTask(message.task_id)
    const parentId = knownParent(message.parent_task_id) ?? known.parentId
    const task = {
      ...known,
      type: message.task_type ?? "",
      toolUseId: message.tool_use_id ?? null,
      parentId,
      depth: message.spawn_depth ?? (parentId ? (state.tasks[parentId]?.depth ?? 0) + 1 : 1),
      state: "running" as const,
      name: (tool?.kind === "tool" ? tool.agent?.name : undefined) ?? message.description ?? "",
      description: message.description ?? "",
      prompt: message.prompt ?? "",
      workflowName: message.workflow_name ?? "",
      startedAt: now + shift,
      command: commandOf(tool) || known.command,
    }
    task.background ||= message.is_backgrounded === true
    setState("tasks", message.task_id, task)
    updateTool(task, (item) => {
      item.taskId = task.id
      if (!item.agent) return
      item.agent.prompt ||= task.prompt
      item.agent.type ||= message.subagent_type ?? ""
    })
  }

  function finishTask(id: string, outcome: TaskState): void {
    setTask(id, (task) => {
      task.state = outcome
      task.endedAt ??= now + shift
    })
    updateTool(state.tasks[id], (tool) => {
      if (tool.status === "running") tool.status = toolStatus(outcome)
      if (tool.agent) tool.agent.state = outcome
    })
  }

  function onBackgroundTasks(message: System<"background_tasks_changed">): void {
    const next = new Set<string>()
    for (const entry of message.tasks) {
      if (entry.ambient) continue
      next.add(entry.task_id)
      const task = state.tasks[entry.task_id] ?? {
        ...blankTask(entry.task_id),
        type: entry.task_type ?? "",
        name: entry.description ?? "",
        description: entry.description ?? "",
      }
      const parentId = knownParent(entry.parent_task_id) ?? task.parentId
      setState("tasks", entry.task_id, { ...task, background: true, parentId })
    }
    // A task that leaves the live set without a notification was lost; it no longer runs.
    for (const id of live) if (!next.has(id) && state.tasks[id]?.state === "running") finishTask(id, "stopped")
    live = next
  }

  function onSystem(message: Of<"system">): void {
    switch (message.subtype) {
      case "init":
        setState("info", initInfo(message))
        setState("permissionMode", message.permissionMode)
        return
      case "status":
        for (const uuid of message.user_message_uuids ?? []) settleQueued(uuid)
        if (message.permissionMode) setState("permissionMode", message.permissionMode)
        if (message.status !== "requesting") return
        // A turn claude starts itself (a queued message, a background task's end) runs like any other; one that takes
        // in a user message counts as the user's.
        if (state.turn === null) setState("interrupting", false)
        if (message.user_message_uuids?.length) setState("turn", "user")
        else if (state.turn === null) setState("turn", "claude")
        if (state.status === "idle") setState("status", "running")
        return
      // The command list is the input's business (controls.ts).
      case "commands_changed":
        return
      case "compact_boundary":
        add({ kind: "system", id: newId("system"), text: "context compacted", level: "info" }, null)
        return
      case "api_retry":
        return onRetry(message)
      case "background_tasks_changed":
        return onBackgroundTasks(message)
      case "task_started":
        return onTaskStarted(message)
      case "task_progress": {
        // Progress that arrives after the end would replace the final numbers.
        if (state.tasks[message.task_id]?.state !== "running") return
        const workflow = workflowOf(message.workflow_progress, shift)
        setTask(message.task_id, (task) => {
          task.activity = activityOf(message)
          task.lastTool = message.last_tool_name ?? null
          task.toolUses = message.usage.tool_uses
          task.durationMs = message.usage.duration_ms
          task.tokens = message.usage.total_tokens ?? task.tokens
          if (workflow) task.workflow = workflow
        })
        updateTool(state.tasks[message.task_id], (tool) => {
          if (!tool.agent) return
          tool.agent.activity = activityOf(message)
          tool.agent.toolUses = message.usage.tool_uses
          tool.agent.durationMs = message.usage.duration_ms
          tool.agent.tokens = message.usage.total_tokens ?? tool.agent.tokens
        })
        return
      }
      case "task_updated": {
        const patch = message.patch
        setTask(message.task_id, (task) => {
          if (patch.error) task.error = patch.error
          if (patch.is_backgrounded) task.background = true
        })
        updateTool(state.tasks[message.task_id], (tool) => {
          if (tool.agent && patch.error) tool.agent.error = patch.error
        })
        const task = state.tasks[message.task_id]
        const outcome = patch.status === "killed" ? "stopped" : patch.status
        if (task && isShell(task) && (outcome === "completed" || outcome === "failed" || outcome === "stopped"))
          finishTask(task.id, outcome)
        return
      }
      case "task_notification": {
        const usage = message.usage
        setTask(message.task_id, (task) => {
          task.summary = message.summary
          task.outputFile = message.output_file ?? null
          if (usage) {
            task.toolUses = usage.tool_uses
            task.durationMs = usage.duration_ms
            task.tokens = usage.total_tokens ?? task.tokens
          }
        })
        updateTool(state.tasks[message.task_id], (tool) => {
          if (!tool.agent) return
          tool.agent.report = message.summary
          if (usage) {
            tool.agent.toolUses = usage.tool_uses
            tool.agent.durationMs = usage.duration_ms
            tool.agent.tokens = usage.total_tokens ?? tool.agent.tokens
          }
        })
        finishTask(message.task_id, message.status)
        const task = state.tasks[message.task_id]
        if (task && isShell(task) && !shellEnds.has(task.id)) {
          shellEnds.add(task.id)
          add({ kind: "shell-end", id: newId("shell-end"), taskId: task.id }, null)
        }
        return
      }
    }
  }

  function onIncoming(message: ProtocolMessage): void {
    switch (message.type) {
      case "system":
        return onSystem(message)
      case "stream_event":
        return onStreamEvent(message)
      case "assistant":
        return onAssistant(message)
      case "user":
        return onToolResults(message)
      case "result":
        return onResult(message)
      case "control_request": {
        const request = message.request
        if (request.subtype !== "can_use_tool") return
        add(
          {
            kind: "ask",
            id: `ask-${message.request_id}`,
            requestId: message.request_id,
            toolUseId: request.tool_use_id,
            toolName: request.tool_name,
            displayName: request.display_name ?? request.tool_name,
            input: request.input,
            description: request.description ?? "",
            reason: Bun.stripANSI(request.decision_reason ?? ""),
            suggestion: request.suppress_always_allow_rule ? null : firstSuggestion(request.permission_suggestions),
            defaultToNo: request.default_to_no ?? false,
            safetyCheck: request.decision_reason_type === "safetyCheck",
            status: "pending",
            answers: {},
            notes: {},
            denial: "",
          },
          null,
        )
        return
      }
      case "control_response": {
        // The reply to an interrupt that came after its turn's result (or raced it) leaves nothing to interrupt.
        if (message.response.request_id === interruptId) {
          interruptId = null
          if (state.turn === null) setState("interrupting", false)
          return
        }
        const taskId = outputRequests.get(message.response.request_id)
        if (!taskId) return
        outputRequests.delete(message.response.request_id)
        const reply = taskOutput.safeParse(message.response.response)
        if (!reply.success) return
        setTask(taskId, (task) => {
          task.output = reply.data.output
          task.outputBytes = reply.data.total_bytes
          task.truncated = reply.data.truncated
        })
        return
      }
      case "command_lifecycle":
        if (message.state !== "queued") settleQueued(message.command_uuid)
        return
      case "control_cancel_request":
        update(`ask-${message.request_id}`, (item) => {
          if (item.kind === "ask" && item.status === "pending") item.status = "cancelled"
        })
        return
      case "rate_limit_event":
        return onRateLimit(message)
    }
  }

  function onOutgoing(message: ProtocolMessage): void {
    if (message.type === "user") {
      // A message sent after a rewind makes it final: the hidden prompts go for good.
      const rewound = state.rewound
      if (rewound) {
        const cut = state.items.indexOf(rewound.userId)
        if (cut >= 0) setState("items", state.items.slice(0, cut))
        setState("rewound", null)
      }
      const { text, images } = describeUserContent(message.message.content)
      const id = newId("user")
      // Only a message sent during a turn waits; one sent while idle starts its own turn.
      const queued = state.status === "running" && message.uuid !== undefined
      add({ kind: "user", id, text, images, queue: queued ? "queued" : null }, null)
      if (queued && message.uuid) waiting.set(message.uuid, id)
      else setState("turn", "user")
      // A message queued during a turn keeps that turn's interrupt; a fresh turn drops one that raced the result.
      if (state.status !== "running") setState("interrupting", false)
      setState("status", "running")
    } else if (message.type === "control_request" && message.request.subtype === "interrupt") {
      // An interrupt that goes out after its turn's result already came in has nothing left to interrupt.
      if (state.turn === null) return
      interruptId = message.request_id
      setState("interrupting", true)
    } else if (message.type === "control_request" && message.request.subtype === "get_task_output") {
      outputRequests.set(message.request_id, message.request.task_id)
    } else if (message.type === "control_response") {
      const payload = message.response.response
      const parsed = payload === undefined ? null : permissionReply.safeParse(payload)
      // A reply that cannot be read must not settle the ask, least of all as allowed.
      if (parsed && !parsed.success) {
        log.warn(`invalid control_response message: ${parsed.error.message}`)
        unreadable("control_response")
        return
      }
      const reply = parsed?.data
      const id = `ask-${message.response.request_id}`
      const ask = state.byId[id]
      const question = ask?.kind === "ask" && (ask.toolName === "AskUserQuestion" || ask.toolName === OWN_ASK)
      const answered =
        question && reply?.updatedInput !== undefined ? questionAnswers.safeParse(reply.updatedInput) : null
      if (answered && !answered.success) {
        log.warn(`invalid control_response message: ${answered.error.message}`)
        unreadable("control_response")
        return
      }
      update(id, (item) => {
        // The first response settles the ask; in replay that is the user's own, and the recorded one comes after.
        if (item.kind !== "ask" || item.status !== "pending") return
        const answers = answered?.data.answers
        if (reply?.behavior === "deny") item.status = "denied"
        else if (answers) item.status = "answered"
        else item.status = "allowed"
        item.answers = answers ?? {}
        item.notes = notesOf(answered?.data.annotations)
        item.denial = reply?.behavior === "deny" ? (reply.message ?? "") : ""
      })
    }
  }

  function unreadable(key: string): void {
    const seen = invalid.get(key)
    if (!seen) {
      const id = newId("system")
      invalid.set(key, { id, count: 1 })
      add({ kind: "system", id, text: `Could not read a ${key} message`, level: "warning" }, null)
      return
    }
    seen.count += 1
    update(seen.id, (item) => {
      if (item.kind === "system") item.text = `Could not read ${key} messages (×${seen.count})`
    })
  }

  function stopRunning(): void {
    for (const task of Object.values(state.tasks)) if (task.state === "running") finishTask(task.id, "stopped")
    for (const item of Object.values(state.byId)) {
      if (item.kind !== "tool" || (item.status !== "running" && item.agent?.state !== "running")) continue
      update(item.id, (tool) => {
        if (tool.kind !== "tool") return
        if (tool.status === "running") tool.status = "stopped"
        if (tool.agent?.state === "running") tool.agent.state = "stopped"
      })
    }
  }

  return {
    state,
    apply(dir, parsed, at) {
      if (dir === "in" && state.status === "starting") setState("status", "idle")
      now = at
      shift = Date.now() - at
      if (state.usage.startedAt === null) setState("usage", "startedAt", Date.now())
      if (parsed.kind === "invalid") return unreadable(parsed.key)
      if (parsed.kind === "unknown") return
      if (dir === "in") onIncoming(parsed.message)
      else onOutgoing(parsed.message)
    },
    prepend(events) {
      const earlier = createSession({ idPrefix: `p${++prepends}-` })
      for (const event of events) earlier.apply(event.dir, parse(event.line), event.at)
      earlier.stopRunning()
      setState("byId", earlier.state.byId)
      setState("items", (ids) => [...earlier.state.items, ...ids])
    },
    rewind(rewound) {
      setState("rewound", rewound)
    },
    redo() {
      setState("rewound", null)
    },
    answer(response) {
      const parsed = parse(response)
      if (parsed.kind === "message") onOutgoing(parsed.message)
    },
    // For a stored transcript: work with no recorded outcome will never finish.
    stopRunning,
    setPermissionMode(mode) {
      setState("permissionMode", mode)
    },
    interruptFailed() {
      interruptId = null
      setState("interrupting", false)
    },
    end(problem) {
      for (const id of Object.keys(state.byId)) stopStreaming(id)
      cursors.clear()
      if (problem) {
        stopRunning()
        for (const item of Object.values(state.byId)) {
          if (item.kind !== "ask" || item.status !== "pending") continue
          update(item.id, (ask) => {
            if (ask.kind === "ask") ask.status = "cancelled"
          })
        }
        dropRetry()
        add({ kind: "system", id: newId("system"), text: problem.text, level: "error", detail: problem.detail }, null)
      }
      // A message still waiting never ran.
      for (const id of waiting.values())
        update(id, (item) => {
          if (item.kind === "user") item.queue = "not sent"
        })
      waiting.clear()
      setState("turn", null)
      setState("interrupting", false)
      setState("status", "ended")
    },
  }
}
