import { basename } from "node:path"
import { createStore, produce } from "solid-js/store"
import { log } from "../log/log.ts"
import {
  isOwnAskServer,
  mcpCancelled,
  type McpMessage,
  OWN_ASK,
  OWN_ASK_SERVER,
  ownAskCall,
  ownAskResult,
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
import { readAgentMessage } from "./agent-message.ts"
import { answersInResult, askKeys } from "./ask.ts"
import { LOGIN_HINT, needsLogin } from "./login.ts"
import { hiddenSpan, type Rewound } from "./rewind.ts"
import { isShell } from "./shells.ts"
import { agentOf, sendMessageSummary, summarizeToolInput } from "./tool-summary.ts"
import type {
  Agent,
  Ask,
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
  UserMessage,
  Window,
  WorkflowProgress,
} from "./types.ts"

export type SessionStore = {
  state: Session
  apply(dir: "in" | "out", parsed: ParseResult, at: number): void
  prepend(events: SourceEvent[]): void
  answer(response: string): void
  // Opens our own ask held for this tool_use until the ask server knew it was the main agent's.
  openOwnAsk(toolUseId: string): void
  // A message shown at Enter, before it goes out; it waits until it does.
  showEarly(line: string): void
  // A message shown early never went out.
  notSent(uuid: string): void
  stopRunning(): void
  setLists(lists: Partial<Pick<Session, "mcpServers" | "plugins">>): void
  setPermissionMode(mode: string): void
  // The user asked to interrupt the turn; the request may wait for the message that starts it.
  interrupting(): void
  // The interrupt was refused or timed out, so the turn goes on and may be interrupted again.
  interruptFailed(): void
  // An ended session gets a new claude; the chat stays as it was.
  restart(): void
  // With a problem, Claude Code went away on its own: running work stops and the chat ends with an error row.
  end(problem?: SessionEnd): void
  rewind(rewound: Rewound): void
  redo(): void
  // Called with the tasks a rewind stops or leaves running. A turn claude starts by itself because one of them ended is
  // not shown, and `onStart` is called as it starts so it can be interrupted: stopping a background agent makes claude
  // start one.
  hideTurnsOf(taskIds: string[], onStart: () => void): void
  // Called with what a main-thread Edit or Write found in its file (null: no file), for whoever needs to check it now;
  // nothing keeps the text.
  onFileOriginal(listener: (toolUseId: string, original: string | null) => void): void
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

function describeUserContent(content: string | UserBlock[]): {
  text: string
  images: ChatImage[]
  to: UserMessage["to"]
} {
  const raw =
    typeof content === "string"
      ? content
      : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
  const images = typeof content === "string" ? [] : imagesOf(content, numbered)
  const message = readAgentMessage(raw)
  if (message) return { text: message.text, images, to: { id: message.id, name: message.name } }
  return { text: raw, images, to: null }
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
    mcpServers: message.mcp_servers
      .filter((server) => !isOwnAskServer(server))
      .map((server) => ({
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
    mcpServers: null,
    plugins: null,
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
    claudeTitle: null,
    conversation: 0,
    compacting: false,
    carried: [],
  })
  const cursors = new Map<string, Cursor>()
  const originalListeners: ((toolUseId: string, original: string | null) => void)[] = []
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
  // Calls to our own ask not yet known to be the main agent's, by tool_use id.
  const heldAsks = new Map<string, Ask>()
  let interruptId: string | null = null
  // Messages sent during a turn that claude has not taken in yet: uuid → user item.
  const waiting = new Map<string, ItemId>()
  // Messages shown at Enter that have not gone out yet, by uuid: true for one that starts its own turn.
  const early = new Map<string, boolean>()
  // Tasks from rewound prompts, stopped or left running, whose notification has not led to a turn yet.
  const hideFor = new Set<string>()
  // Tasks with a notification since the last init, and the latest one.
  const noticed = new Set<string>()
  let lastNoticed: string | null = null
  let onHiddenStart: (() => void) | null = null
  // A turn claude started by itself runs and is not shown.
  let hiding = false
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
  // The uuids of claude's own replies to local commands (/context, /model) shown so far.
  const localOutputs = new Set<string>()
  // Tool calls that messages named as their parent but that are not here; logged once each.
  const lostParents = new Set<string>()
  const idPrefix = options?.idPrefix ?? ""
  const newId = (prefix: string): ItemId => `${idPrefix}${prefix}-${++counter}`

  // What the main model does to pass on a message to an agent stays out of the chat, unless the call fails.
  // `own`: the message started its turn, so the model's whole turn is about passing it on. `touched`: the model has
  // answered since, so the next result ends that turn.
  const pendingMessages: { to: string; userId: ItemId; own: boolean; touched: boolean }[] = []
  let quietIds: ItemId[] = []
  let afterSend = false

  function quietOnStart(item: Item): boolean {
    const after = afterSend
    afterSend = false
    for (const pending of pendingMessages) pending.touched = true
    if (item.kind === "text") return after
    if (item.kind !== "tool" || pendingMessages.length === 0) return false
    if (item.name !== "ToolSearch" && item.name !== "SendMessage") return false
    quietIds.push(item.id)
    return true
  }

  function unquiet(ids: ItemId[]): void {
    for (const id of ids)
      update(id, (item) => {
        if (item.kind === "tool" || item.kind === "text") item.quiet = false
      })
  }

  function messageIdOf(input: unknown): string | undefined {
    const to = typeof input === "object" && input !== null && "to" in input ? input.to : undefined
    return typeof to === "string" && pendingMessages.some((entry) => entry.to === to) ? to : undefined
  }

  function add(item: Item, parent: string | null | undefined): void {
    if (!parent && (item.kind === "text" || item.kind === "tool") && quietOnStart(item)) item.quiet = true
    const parentItem = parent ? state.byId[parent] : undefined
    // A subagent's message whose call is gone (a /clear took it) must not read as the main agent's.
    if (parent && parentItem?.kind !== "tool") {
      if (!lostParents.has(parent)) log.warn("dropped messages under an unknown tool call", { parent })
      lostParents.add(parent)
      return
    }
    setState("byId", item.id, item)
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
    const sent =
      block.type === "tool_use" && block.name === "SendMessage" ? sendMessageSummary(block.input, state.tasks) : ""
    update(id, (item) => {
      if (item.kind === "text" && block.type === "text") {
        item.markdown = block.text
        item.streaming = false
        if (item.quiet && (block.text.trim().includes("\n") || block.text.length > 160)) item.quiet = false
      } else if (item.kind === "thinking" && block.type === "thinking") {
        if (block.thinking) item.text = block.thinking
        endThinking(item)
      } else if (item.kind === "tool" && block.type === "tool_use") {
        item.input = block.input
        item.inputText = JSON.stringify(block.input)
        if (item.quiet && item.name === "ToolSearch" && !(JSON.stringify(block.input) ?? "").includes("SendMessage"))
          item.quiet = false
        if (item.quiet && item.name === "SendMessage" && messageIdOf(block.input) === undefined) item.quiet = false
        item.summary = sent || summarizeToolInput(block.input)
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
    const text = () =>
      message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
    // claude repeats an API error as a reply of its own, and the turn's end already shows it.
    if (message.is_api_error_message) {
      if (needsLogin(message.error, text())) loginNeeded = true
      return
    }
    // claude's own reply, such as the output of `/context`; it carries no usage.
    const local = message.message.model === "<synthetic>"
    // A compaction that keeps a local command's output prints it again, under the same uuid.
    if (local && message.uuid) {
      if (localOutputs.has(message.uuid)) return
      localOutputs.add(message.uuid)
    }
    // A local command that failed (a compaction the API refused) says why in a reply of its own.
    if (message.local_command_outcome?.kind === "failed") {
      if (text().trim()) add({ kind: "system", id: newId("system"), text: text(), level: "warning" }, null)
      return
    }
    dropRetry()
    const key = message.parent_tool_use_id ?? MAIN
    const usage = message.message.usage
    if (usage && !message.parent_tool_use_id && !local) {
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
      add(local && item.kind === "text" ? { ...item, local } : item, message.parent_tool_use_id)
      finalize(item.id, block)
      stopStreaming(item.id)
    }
  }

  function onToolResults(message: Of<"user">): void {
    if (message.isReplay || typeof message.message.content === "string") return
    const fileResult = message.tool_use_result
    const parent = message.parent_tool_use_id ? state.byId[message.parent_tool_use_id] : undefined
    const agentStopped = parent?.kind === "tool" && parent.agent?.state === "stopped"
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue
      const original = fileResult?.originalFile
      if (original !== undefined && !message.parent_tool_use_id)
        for (const listener of originalListeners) listener(block.tool_use_id, original)
      const tool = state.byId[block.tool_use_id]
      // A call read back from a transcript saw no task_started; its result still names the agent.
      const agentId = fileResult?.agentId
      if (tool?.kind === "tool" && tool.name === "Agent" && !tool.taskId && agentId)
        update(tool.id, (item) => {
          if (item.kind === "tool") item.taskId = agentId
        })
      const task = tool?.kind === "tool" && tool.taskId ? state.tasks[tool.taskId] : undefined
      if (tool?.kind === "tool" && tool.name === "SendMessage") settleMessage(tool, block)
      const skipped = message.tool_result_meta?.find((meta) => meta.id === block.tool_use_id)?.non_execution_kind
      update(block.tool_use_id, (item) => {
        if (item.kind !== "tool") return
        // An interrupt or a stop of its agent stops the tool; claude's rejection text is meant for the model.
        if (skipped === "user-rejected" || skipped === "interrupted" || (agentStopped && block.is_error)) {
          item.status = "stopped"
          item.result = ""
          if (item.agent) {
            item.agent.state = "stopped"
            item.agent.stoppedByUser = true
          }
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
        // A subagent's lines carry no tool_use_result; Write's own reply says whether it made the file.
        if (!fileResult && item.name === "Write" && item.result.startsWith("File created successfully"))
          item.createdFile = true
        if (fileResult?.type === "file_unchanged") item.unchanged = true
        if (item.agent && !launched) {
          // An agent the user stopped ends with an error result, and it stays stopped.
          if (item.agent.state !== "stopped") item.agent.state = block.is_error ? "failed" : "completed"
          item.agent.report = item.result
        }
      })
    }
  }

  function settleMessage(tool: ToolCall, block: { is_error?: boolean; content?: ResultContent }): void {
    const to = messageIdOf(tool.input)
    if (to === undefined) return
    const [entry] = pendingMessages.splice(
      pendingMessages.findIndex((pending) => pending.to === to),
      1,
    )
    const text = toolResultText(block.content)
    const refused = block.is_error === true || /"success"\s*:\s*false/.test(text)
    const ids = quietIds
    quietIds = []
    if (refused) return unquiet(ids)
    afterSend = entry?.own === true
    if (entry)
      update(entry.userId, (item) => {
        if (item.kind === "user") item.delivery = /resumedAgentId|Resuming agent/.test(text) ? "resumed" : "sent"
      })
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
    // A message the model has not answered yet may wait for the next turn; a result before it is an earlier turn's.
    for (let at = pendingMessages.length - 1; at >= 0; at--)
      if (pendingMessages[at]?.touched) pendingMessages.splice(at, 1)
    quietIds = []
    afterSend = false
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
    // A local command (/context, /compact, /clear) made no model turn to time; one that failed still says why.
    if (!message.local_command || message.is_error)
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
    setState("compacting", false)
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
    const earlier = known.toolUseId ? state.byId[known.toolUseId] : undefined
    const resumes = tool?.kind === "tool" && tool.name === "SendMessage" && earlier?.kind === "tool" && !!earlier.agent
    if (resumes && earlier.agent) {
      const agent: Agent = {
        ...earlier.agent,
        prompt: message.prompt ?? "",
        state: "running",
        tokens: 0,
        toolUses: 0,
        durationMs: 0,
        report: "",
        error: null,
        activity: "",
        stoppedByUser: false,
      }
      update(tool.id, (item) => {
        if (item.kind === "tool") {
          item.agent = agent
          item.quiet = false
        }
      })
    }
    const task = {
      ...known,
      type: message.task_type ?? "",
      toolUseId: message.tool_use_id ?? null,
      parentId,
      depth: message.spawn_depth ?? (parentId ? (state.tasks[parentId]?.depth ?? 0) + 1 : 1),
      state: "running" as const,
      name:
        (tool?.kind === "tool" ? tool.agent?.name : undefined) ??
        (resumes ? known.name : undefined) ??
        message.description ??
        "",
      description: message.description ?? "",
      prompt: message.prompt ?? "",
      workflowName: message.workflow_name ?? "",
      startedAt: now + shift,
      command: commandOf(tool) || known.command,
    }
    task.background ||= message.is_backgrounded === true || resumes
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
        // A mode change reports itself as a status too, and says nothing about a compaction going on.
        if (message.status === "compacting") setState("compacting", true)
        else if (!message.permissionMode) setState("compacting", false)
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
      case "session_title_changed":
        setState("claudeTitle", message.title)
        return
      case "compact_boundary": {
        add({ kind: "system", id: newId("system"), text: "context compacted", level: "info" }, null)
        setState("compacting", false)
        const left = message.compact_metadata.post_tokens
        if (left !== undefined) setState("usage", "context", "used", left)
        return
      }
      case "local_command_output":
        add({ kind: "text", id: newId("text"), markdown: message.content, streaming: false, local: true }, null)
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
        if (message.stopped_by_user)
          update(state.tasks[message.task_id]?.toolUseId ?? message.tool_use_id ?? "", (item) => {
            if (item.kind === "tool" && item.agent) item.agent.stoppedByUser = true
          })
        // A task this session never saw start (a call read back from a transcript) still ends its call.
        if (!state.tasks[message.task_id] && message.tool_use_id)
          update(message.tool_use_id, (item) => {
            if (item.kind !== "tool") return
            if (item.status === "running") item.status = toolStatus(message.status)
            if (!item.agent) return
            item.agent.state = message.status
            item.agent.report = message.summary
          })
        const task = state.tasks[message.task_id]
        if (task && isShell(task) && !shellEnds.has(task.id)) {
          shellEnds.add(task.id)
          add({ kind: "shell-end", id: newId("shell-end"), taskId: task.id }, null)
        }
        return
      }
    }
  }

  // A turn is ours to hide when its init has no user_message_uuids, none of our messages waits, and the latest task
  // notification before it is about a task from the rewound prompts (probe P6). Any init uses up the notifications
  // before it, so each task hides one turn at most. The turn's lines go nowhere; the tasks' own lines still apply.
  function hidden(message: ProtocolMessage): boolean {
    if (message.type === "system" && message.subtype === "task_notification") {
      noticed.add(message.task_id)
      lastNoticed = message.task_id
      return false
    }
    if (message.type === "system" && message.subtype === "init") {
      const ours =
        !message.user_message_uuids?.length &&
        lastNoticed !== null &&
        hideFor.has(lastNoticed) &&
        state.turn === null &&
        waiting.size === 0 &&
        early.size === 0
      for (const id of noticed) hideFor.delete(id)
      noticed.clear()
      lastNoticed = null
      if (ours) {
        hiding = true
        log.info("hiding a turn claude started by itself")
        onHiddenStart?.()
      }
      return false
    }
    if (!hiding) return false
    if (message.type === "result") {
      hiding = false
      return true
    }
    if (message.type === "assistant" || message.type === "stream_event" || message.type === "user")
      return !message.parent_tool_use_id
    return message.type === "system" && (message.subtype === "status" || message.subtype === "api_retry")
  }

  function onIncoming(message: ProtocolMessage): void {
    if (hidden(message)) return
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
        if (request.subtype === "mcp_message") return onOwnAskMessage(message.request_id, request)
        // Our own ask opens from its tools/call; a permission ask for it is allowed at once.
        if (request.subtype !== "can_use_tool" || request.tool_name === OWN_ASK) return
        const agent = request.agent_id ? state.tasks[request.agent_id]?.name : undefined
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
            ...(agent ? { agent } : {}),
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
          // A shell's output only grows, so a smaller tail is a late reply to an older read.
          if (reply.data.total_bytes < task.outputBytes) return
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
      case "conversation_reset":
        return reset()
      case "tool_progress":
        return
    }
  }

  function onOwnAskMessage(requestId: string, request: McpMessage): void {
    if (request.server_name !== OWN_ASK_SERVER) return
    const { id: rpcId, method, params } = request.message
    if (method === "notifications/cancelled") {
      const cancelled = mcpCancelled.safeParse(params).data
      if (cancelled) cancelOwnAsks((ask) => ask.mcp?.rpcId === cancelled.requestId)
      return
    }
    const call = ownAskCall.safeParse(params).data
    if (method !== "tools/call" || rpcId === undefined || call?.name !== "ask") return
    const ask: Ask = {
      kind: "ask",
      id: `ask-${requestId}`,
      requestId,
      toolUseId: call.toolUseId,
      toolName: OWN_ASK,
      displayName: "ask",
      input: call.input,
      description: "",
      reason: "",
      suggestion: null,
      defaultToNo: false,
      safetyCheck: false,
      status: "pending",
      answers: {},
      notes: {},
      denial: "",
      mcp: { rpcId },
    }
    // Only the main agent's call opens. Its tool_use line came first; any other call waits for the ask server to
    // place it (openOwnAsk) or turn it down.
    const tool = state.byId[call.toolUseId]
    if (tool && state.items.includes(tool.id)) add(ask, null)
    else heldAsks.set(call.toolUseId, ask)
  }

  function cancelOwnAsks(which: (ask: Ask) => boolean = () => true): void {
    for (const [toolUseId, held] of heldAsks) if (which(held)) heldAsks.delete(toolUseId)
    for (const item of Object.values(state.byId)) {
      if (item.kind !== "ask" || !item.mcp || item.status !== "pending" || !which(item)) continue
      update(item.id, (ask) => {
        if (ask.kind === "ask") ask.status = "cancelled"
      })
    }
  }

  // Our own ask settles from its MCP result: an error is a denial, else the answers are read back from the text.
  function settleOwnAsk(id: string, payload: unknown): void {
    const result = ownAskResult.safeParse(payload).data?.mcp_response.result
    if (!result) return
    const text = result.content.map((block) => block.text ?? "").join("")
    update(id, (item) => {
      if (item.kind !== "ask" || item.status !== "pending") return
      if (result.isError) {
        item.status = "denied"
        item.denial = text
        return
      }
      const { answers, notes } = answersInResult(text, askKeys(item.input))
      item.status = "answered"
      item.answers = answers
      item.notes = notes
    })
  }

  function onOutgoing(message: ProtocolMessage, shownEarly = false): void {
    if (message.type === "user" && !shownEarly && message.uuid !== undefined && early.has(message.uuid)) {
      // Shown already; one that starts a turn waits for nothing once it is out.
      if (early.get(message.uuid)) settleQueued(message.uuid)
      early.delete(message.uuid)
    } else if (message.type === "user") {
      // A message sent after a rewind makes it final: the hidden prompts go for good.
      const span = hiddenSpan(state.items, state.rewound)
      if (span) setState("items", [...state.items.slice(0, span.start), ...state.items.slice(span.end)])
      if (state.rewound) setState("rewound", null)
      const { text, images, to } = describeUserContent(message.message.content)
      const id = newId("user")
      // Only a message sent during a turn waits; one sent while idle starts its own turn. A transcript's prompts all
      // ran already. One shown before it goes out waits until it does, but looks queued only behind a running turn.
      const running = state.status === "running"
      const queued = (running || shownEarly) && message.uuid !== undefined && !message.isReplay
      add({ kind: "user", id, text, images, to, queue: queued && running ? "queued" : null, uuid: message.uuid }, null)
      if (to) pendingMessages.push({ to: to.id, userId: id, own: !running, touched: false })
      else {
        afterSend = false
        for (const pending of pendingMessages) pending.own = false
      }
      if (queued && message.uuid) waiting.set(message.uuid, id)
      if (shownEarly && message.uuid) early.set(message.uuid, !running)
      if (!queued || !running) setState("turn", "user")
      // A message queued during a turn keeps that turn's interrupt; a fresh turn drops one that raced the result.
      if (state.status !== "running") setState("interrupting", false)
      setState("status", "running")
    } else if (message.type === "control_request" && message.request.subtype === "interrupt") {
      // An interrupt that goes out after its turn's result already came in has nothing left to interrupt.
      if (state.turn === null) return
      interruptId = message.request_id
      setState("interrupting", true)
    } else if (message.type === "control_request" && message.request.subtype === "stop_task") {
      const stopped = state.tasks[message.request.task_id]
      updateTool(stopped, (tool) => {
        if (tool.agent) tool.agent.stoppedByUser = true
      })
    } else if (message.type === "control_request" && message.request.subtype === "get_task_output") {
      outputRequests.set(message.request_id, message.request.task_id)
    } else if (message.type === "control_response") {
      const payload = message.response.response
      for (const [toolUseId, held] of heldAsks)
        if (held.requestId === message.response.request_id) return void heldAsks.delete(toolUseId)
      const own = state.byId[`ask-${message.response.request_id}`]
      if (own?.kind === "ask" && own.mcp) return settleOwnAsk(own.id, payload)
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

  // The chat starts over; the /clear's own result is still to come. Messages sent after the /clear that claude has
  // not taken in yet run in the new conversation, an ask still open waits for its answer, and work still running in
  // the process goes on: agents and workflows keep their steps off the chat, in the agent panel.
  function reset(): void {
    const byId = state.byId
    const queued = new Set(waiting.values())
    const items = state.items.filter((id) => {
      const item = byId[id]
      return queued.has(id) || (item?.kind === "ask" && item.status === "pending")
    })
    const goesOn = (id: ItemId) => {
      const item = byId[id]
      if (item?.kind !== "tool" || (item.agent === null && item.name !== "Agent" && item.name !== "Workflow"))
        return false
      return item.taskId !== null && state.tasks[item.taskId]?.state === "running"
    }
    // A running agent goes with all its steps; under a finished call (a foreground agent that started a background
    // one and returned) a running one is looked for.
    const carried: ItemId[] = []
    const find = (id: ItemId): void => {
      const item = byId[id]
      if (goesOn(id)) carried.push(id)
      else if (item?.kind === "tool") for (const child of item.children) find(child)
    }
    for (const id of [...state.carried, ...state.items]) find(id)
    const kept = new Set(items)
    const keep = (id: ItemId) => {
      kept.add(id)
      const item = byId[id]
      if (item?.kind === "tool") for (const child of item.children) keep(child)
    }
    for (const id of carried) keep(id)
    for (const key of cursors.keys()) if (!kept.has(key)) cursors.delete(key)
    for (const id of thinkingSince.keys()) if (!kept.has(id)) thinkingSince.delete(id)
    invalid.clear()
    retryId = null
    retryAttempt = 0
    setState(
      produce((session) => {
        for (const id of Object.keys(session.byId)) if (!kept.has(id)) delete session.byId[id]
        session.items = items
        session.carried = carried
        for (const [id, task] of Object.entries(session.tasks)) if (task.state !== "running") delete session.tasks[id]
        session.rewound = null
        session.compacting = false
        session.claudeTitle = null
        session.usage.tokens = 0
        session.usage.costUsd = 0
        session.usage.context.used = 0
        session.usage.startedAt = Date.now()
        session.conversation += 1
      }),
    )
  }

  // A resumed agent's lines still name its first Agent call; its run is the SendMessage call's row.
  function resumedLines<M extends ProtocolMessage>(message: M): M {
    const parent =
      "parent_tool_use_id" in message && typeof message.parent_tool_use_id === "string"
        ? message.parent_tool_use_id
        : null
    const call = parent ? state.byId[parent] : undefined
    const task = call?.kind === "tool" && call.taskId ? state.tasks[call.taskId] : undefined
    if (!parent || !task?.toolUseId || task.toolUseId === parent || task.state !== "running") return message
    return { ...message, parent_tool_use_id: task.toolUseId }
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
      if (dir === "in") onIncoming(resumedLines(parsed.message))
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
      setState("rewound", { ...rewound, last: rewound.last ?? state.items.at(-1) })
    },
    redo() {
      setState("rewound", null)
      // A task we stopped may still bring its turn; one still running belongs to the conversation again.
      for (const id of hideFor) if (state.tasks[id]?.state === "running") hideFor.delete(id)
    },
    onFileOriginal(listener) {
      originalListeners.push(listener)
    },
    hideTurnsOf(taskIds, onStart) {
      for (const id of taskIds) hideFor.add(id)
      onHiddenStart = onStart
    },
    openOwnAsk(toolUseId) {
      const held = heldAsks.get(toolUseId)
      if (!held) return
      heldAsks.delete(toolUseId)
      add(held, null)
    },
    answer(response) {
      const parsed = parse(response)
      if (parsed.kind === "message") onOutgoing(parsed.message)
    },
    showEarly(line) {
      const parsed = parse(line)
      if (parsed.kind === "message") onOutgoing(parsed.message, true)
    },
    notSent(uuid) {
      const startsTurn = early.get(uuid)
      early.delete(uuid)
      const id = waiting.get(uuid)
      if (!id) return
      waiting.delete(uuid)
      update(id, (item) => {
        if (item.kind === "user") item.queue = "not sent"
      })
      if (startsTurn && waiting.size === 0) {
        setState("turn", null)
        setState("status", "idle")
      }
    },
    // For a stored transcript: work with no recorded outcome will never finish.
    stopRunning,
    setLists(lists) {
      if (lists.mcpServers !== undefined) setState("mcpServers", lists.mcpServers)
      if (lists.plugins !== undefined) setState("plugins", lists.plugins)
    },
    setPermissionMode(mode) {
      setState("permissionMode", mode)
    },
    interrupting() {
      if (state.turn !== null) setState("interrupting", true)
    },
    interruptFailed() {
      interruptId = null
      setState("interrupting", false)
    },
    restart() {
      // The new claude numbers its requests from the start again.
      interruptId = null
      outputRequests.clear()
      hiding = false
      hideFor.clear()
      cancelOwnAsks()
      setState("status", "starting")
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
      // claude is gone, and with it the call our own ask would answer.
      cancelOwnAsks()
      // A message still waiting never ran.
      for (const id of waiting.values())
        update(id, (item) => {
          if (item.kind === "user") item.queue = "not sent"
        })
      waiting.clear()
      early.clear()
      hiding = false
      setState("turn", null)
      setState("interrupting", false)
      setState("compacting", false)
      setState("status", "ended")
    },
  }
}
