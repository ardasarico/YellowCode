import { type Accessor, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Ask as AgentAsk, AskOption, AskOutcome, AskReply } from "../agent/ask.ts"
import type { AgentEvent, BackgroundTask, SessionInfo as AgentInfo } from "../agent/events.ts"
import type { AskId, PartId, PromptId, TaskId, ToolId } from "../agent/ids.ts"
import type { Lists, McpServerRow } from "../agent/lists.ts"
import type { SubagentCall } from "../agent/tools.ts"
import { log } from "../log/log.ts"
import { readSessionMessage } from "../peers/envelope.ts"
import { hiddenSpan, type Rewound } from "./rewind.ts"
import { messageSummary } from "./tool-summary.ts"
import type {
  Agent,
  Item,
  ItemId,
  Session,
  SessionEnd,
  SessionInfo,
  Task,
  TaskState,
  Thinking,
  ToolCall,
  Window,
} from "./types.ts"

type Event<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>

// A prompt as a `user` event gives it.
type UserPrompt = Omit<Event<"user">, "type" | "at">

// The lists the agent pushed, each absent until it does, and `infoServers`, the MCP servers its session info named.
// They are kept apart from `state`, so the state goldens keep their shape; modes and models stay in `state`.
export type PushedLists = Partial<Omit<Lists, "modes" | "models">> & { infoServers?: McpServerRow[] }

export type SessionStore = {
  state: Session
  lists: Accessor<PushedLists>
  event(event: AgentEvent): void
  // An earlier part of the conversation goes in a session of its own, which then goes before this one.
  prepend(events: AgentEvent[]): void
  // A message shown at Enter, before it goes out; it waits until its `user` event comes.
  showEarly(prompt: UserPrompt): void
  // A message shown early never went out.
  notSent(prompt: PromptId): void
  stopRunning(): void
  // Claude's own server and plugin lists, and the server rows it shows for them.
  setLists(lists: Partial<Pick<Session, "mcpServers" | "plugins"> & Pick<Lists, "mcp">>): void
  setPermissionMode(mode: string): void
  // YellowCode's answer to a plan the agent reported without asking.
  settlePlan(id: AskId, reply: AskReply): void
  // The user asked to interrupt the turn; the request may wait for the message that starts it.
  interrupting(): void
  rewind(rewound: Rewound): void
  // A `!` command YellowCode runs itself, shown like a Bash call. `told` is false while the agent has yet to read it.
  startShell(command: string, told: boolean): ItemId
  shellOutput(id: ItemId, output: string): void
  endShell(id: ItemId, output: string, code: number | null, stopped: boolean): void
  redo(): void
  // Called with the tasks a rewind stops or leaves running. A turn the agent starts by itself because one of them ended
  // is not shown, and `onStart` is called as it starts so it can be interrupted: stopping a background agent makes the
  // agent start one.
  hideTurnsOf(taskIds: string[], onStart: () => void): void
  // Called with what a call found in a file it wrote, when the agent reports it (null: no file), for whoever needs to
  // check it now; nothing keeps the text.
  onFileOriginal(listener: (toolUseId: string, path: string, original: string | null) => void): void
}

// The plan band's two answers. With no ask to answer, its no takes no note (question 30).
const planOption = (id: string, effect: "allow" | "deny"): AskOption => ({
  id,
  effect,
  lasts: "once",
  label: null,
  subject: null,
  note: false,
  endsTurn: false,
  mode: null,
})

const FIVE_HOURS = 5 * 60
const WEEK = 7 * 24 * 60

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

function toolStatus(state: TaskState): ToolCall["status"] {
  if (state === "completed") return "done"
  if (state === "failed") return "error"
  return state
}

function toolItem(start: Event<"tool.start">): ToolCall {
  return {
    kind: "tool",
    id: start.id,
    name: start.name,
    toolKind: start.kind,
    title: start.title,
    server: start.mcp?.server ?? null,
    inputText: "",
    input: undefined,
    summary: "",
    detail: null,
    background: false,
    status: "running",
    result: "",
    children: [],
    patch: null,
    createdFile: false,
    content: null,
    images: [],
    unchanged: false,
    count: null,
    files: [],
    questions: null,
    outcome: null,
    agent: null,
    taskId: null,
  }
}

function agentRecord(call: SubagentCall): Agent {
  return {
    ...call,
    tokens: 0,
    state: "running",
    toolUses: 0,
    durationMs: 0,
    report: "",
    error: null,
    activity: "",
    stoppedByUser: false,
  }
}

function blankTask(id: string): Task {
  return {
    id,
    type: "",
    kind: "other",
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
    exitCode: null,
    error: null,
    workflow: null,
    command: "",
    endedAt: null,
    output: null,
    outputBytes: 0,
    truncated: false,
  }
}

export function sessionInfo(info: AgentInfo): SessionInfo {
  return {
    id: info.id,
    model: info.model.id,
    permissionMode: info.mode,
    cwd: info.cwd,
    cliVersion: info.version,
    tools: info.tools.map((tool) => tool.name),
    mcpServers: info.mcpServers.map((server) => ({
      name: server.name,
      status: server.status,
      source: server.origin,
      scope: server.scope,
      error: server.error,
      config: server.config,
      serverInfo: server.server,
      tools: server.tools,
    })),
    skills: info.skills,
    slashCommands: info.commands,
    agents: info.subagents,
    plugins: info.plugins,
    apiKeySource: info.authSource,
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
  const [lists, setPushed] = createSignal<PushedLists>({})
  const push = (pushed: PushedLists) => setPushed((before) => ({ ...before, ...pushed }))
  // Text and thinking parts by the agent's id; `main` is false for a subagent's.
  const parts = new Map<PartId, { id: ItemId; main: boolean }>()
  const originalListeners: ((toolUseId: string, path: string, original: string | null) => void)[] = []
  const invalid = new Map<string, { id: ItemId; count: number }>()
  let counter = 0
  let prepends = 0
  let now = 0
  // Recorded times are shifted by this much so a replay reads them as if they happened just now.
  let shift = 0
  // The background tasks running now, by the latest `tasks.background`.
  let live = new Set<TaskId>()
  // The shell command each call runs, for the task it starts.
  const commands = new Map<ToolId, string>()
  // Messages sent during a turn that the agent has not taken in yet, with their user items.
  const waiting = new Map<PromptId, ItemId>()
  // Messages shown at Enter that have not gone out yet: true for one that starts its own turn.
  const early = new Map<PromptId, boolean>()
  // Tasks from rewound prompts, stopped or left running, whose end has not led to a turn yet.
  const hideFor = new Set<string>()
  let onHiddenStart: (() => void) | null = null
  // A turn the agent started by itself runs and is not shown.
  let hiding = false
  // Shells whose end already has its row; a repeated notification adds no second one.
  const shellEnds = new Set<string>()
  // The live API retry row; it goes once a reply starts or the turn ends.
  let retryId: ItemId | null = null
  let retryAttempt = 0
  // When each streaming thinking block started, so its end can give it a duration.
  const thinkingSince = new Map<ItemId, number>()
  // Tool calls that messages named as their parent but that are not here; logged once each.
  const lostParents = new Set<string>()
  // The call each tool call runs under; null for the main agent's.
  const toolParents = new Map<ToolId, ToolId | null>()
  // User messages by the prompt id they went out with.
  const prompts = new Map<PromptId, ItemId>()
  const idPrefix = options?.idPrefix ?? ""
  const newId = (prefix: string): ItemId => `${idPrefix}${prefix}-${++counter}`

  function unquiet(ids: ItemId[]): void {
    for (const id of ids)
      update(id, (item) => {
        if (item.kind === "tool" || item.kind === "text") item.quiet = false
      })
  }

  // False when the item was dropped.
  function add(item: Item, parent: string | null | undefined): boolean {
    const parentItem = parent ? state.byId[parent] : undefined
    // A subagent's message whose call is gone (a /clear took it) must not read as the main agent's.
    if (parent && parentItem?.kind !== "tool") {
      if (!lostParents.has(parent)) log.warn("dropped messages under an unknown tool call", { parent })
      lostParents.add(parent)
      return false
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
    return true
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

  function onRetry(event: Event<"retry">): void {
    retryAttempt = event.attempt
    const retry = {
      attempt: event.attempt,
      max: event.max,
      delayMs: event.delayMs ?? 0,
      status: event.status,
      reason: event.reason,
      at: now + shift,
    }
    const text = event.max === null ? `API retry ${event.attempt}` : `API retry ${event.attempt}/${event.max}`
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

  // While a hidden turn runs, the main agent's calls stay off the chat.
  const hiddenTool = (id: ToolId) => hiding && !toolParents.get(id)

  function startTool(event: Extract<AgentEvent, { type: "tool.start" }>): void {
    if (hiding && event.parent === null) return
    const parent = event.parent
    const item: ToolCall = { ...toolItem(event), ...(event.quiet ? { quiet: true } : {}) }
    if (!add(item, parent)) return
    toolParents.set(item.id, parent)
  }

  function toolCalled(event: Extract<AgentEvent, { type: "tool.called" }>): void {
    if (hiddenTool(event.id)) return
    const summary = event.message ? messageSummary(event.message.to, event.message.text, state.tasks) : ""
    update(event.id, (item) => {
      if (item.kind !== "tool") return
      if (event.kind !== null) item.toolKind = event.kind
      if (event.name !== null) item.name = event.name
      if (event.title !== null) item.title = event.title
      if (event.mcp !== null) item.server = event.mcp.server
      item.input = event.input
      item.inputText = JSON.stringify(event.input)
      item.summary = summary || event.summary
      item.detail = event.detail
      item.background = event.background
      item.questions = event.questions
      item.agent = event.agent ? agentRecord(event.agent) : null
    })
    const tool = state.byId[event.id]
    const taskId = tool?.kind === "tool" ? tool.taskId : null
    const { agent, command } = event
    if (command) commands.set(event.id, command)
    if (taskId && agent) setTask(taskId, (task) => (task.name = agent.name))
    if (taskId && command) setTask(taskId, (task) => (task.command ||= command))
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

  // While a hidden turn runs, the main agent's output stays off the chat.
  function partOf(part: PartId): ItemId | null {
    const known = parts.get(part)
    return known && !(hiding && known.main) ? known.id : null
  }

  function startPart(event: Extract<AgentEvent, { type: "text.start" | "thinking.start" }>): void {
    if (hiding && event.parent === null) return
    const parent = event.parent
    const item: Item =
      event.type === "text.start"
        ? {
            kind: "text",
            id: newId("text"),
            markdown: event.text,
            streaming: true,
            ...(event.local ? { local: true } : {}),
            ...(event.quiet ? { quiet: true } : {}),
          }
        : { kind: "thinking", id: newId("thinking"), text: event.text, streaming: true, durationMs: null }
    parts.set(event.part, { id: item.id, main: parent === null })
    if (event.type === "thinking.start" && event.live) thinkingSince.set(item.id, now)
    add(item, parent)
  }

  function onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "ready":
        if (state.status === "starting") setState("status", "idle")
        return
      case "reply":
        if (!hiding) dropRetry()
        return
      case "context.used":
        if (!hiding) setState("usage", "context", "used", event.tokens)
        return
      case "subagent.model": {
        const model = event.model
        update(event.call, (item) => {
          if (item.kind === "tool" && item.agent && !item.agent.model) item.agent.model = model
        })
        return
      }
      case "text.start":
      case "thinking.start":
        return startPart(event)
      case "text.delta":
      case "thinking.delta": {
        const id = partOf(event.part)
        const text = event.text
        if (id)
          update(id, (item) => {
            if (item.kind === "text" && event.type === "text.delta") item.markdown += text
            else if (item.kind === "thinking" && event.type === "thinking.delta") item.text += text
          })
        return
      }
      case "text.end": {
        const id = partOf(event.part)
        const text = event.text
        if (id)
          update(id, (item) => {
            if (item.kind !== "text") return
            if (text !== null) item.markdown = text
            item.streaming = false
          })
        return
      }
      case "thinking.end": {
        const id = partOf(event.part)
        const text = event.text
        if (id)
          update(id, (item) => {
            if (item.kind !== "thinking") return
            if (text !== null) item.text = text
            endThinking(item)
          })
        return
      }
      case "tool.start":
        return startTool(event)
      case "tool.input.delta": {
        const text = event.text
        if (!hiddenTool(event.id))
          update(event.id, (item) => {
            if (item.kind === "tool") item.inputText += text
          })
        return
      }
      case "tool.called":
        return toolCalled(event)
      case "tool.output": {
        const text = event.text
        if (!hiddenTool(event.id))
          update(event.id, (item) => {
            if (item.kind === "tool" && item.status === "running") item.result = text
          })
        return
      }
      case "tool.end":
        return endTool(event)
      case "delivered": {
        const id = prompts.get(event.prompt)
        const how = event.how
        if (id && !hiding)
          update(id, (item) => {
            if (item.kind === "user") item.delivery = how
          })
        return
      }
      case "shown":
        if (hiding) return
        unquiet([...event.parts.flatMap((part) => parts.get(part)?.id ?? []), ...event.tools])
        return
      case "ask.open":
        return openAsk(event.ask)
      case "ask.close":
        return closeAsk(event.id, event.outcome)
      case "unreadable":
        return unreadable(event.what)
      case "turn.open":
        return openTurn(event)
      case "task.start":
        return startTask(event)
      case "task.progress":
        return taskProgress(event)
      case "workflow":
        return workflowProgress(event)
      case "task.update":
        return updateTask(event)
      case "task.end":
        return endTask(event)
      case "task.stopping":
        updateTool(state.tasks[event.id], (tool) => {
          if (tool.agent) tool.agent.stoppedByUser = true
        })
        return
      case "task.output":
        return taskOutput(event)
      case "tasks.background":
        return backgroundTasks(event.tasks)
      case "info":
        setState("info", sessionInfo(event.info))
        push({ infoServers: event.info.mcpServers })
        return
      case "mode":
        setState("permissionMode", event.mode)
        return
      case "title":
        setState("claudeTitle", event.title)
        return
      case "user.taken":
        for (const prompt of event.prompts) settleQueued(prompt)
        return
      case "user.dropped":
        return dropQueued(event.prompt)
      case "turn.step":
        return stepTurn(event.prompts)
      case "turn.end":
        return endTurn(event)
      case "context.window":
        if (!hiding) setState("usage", "context", "window", event.tokens)
        return
      case "limits":
        return limits(event)
      case "retry":
        if (!hiding) onRetry(event)
        return
      case "compaction":
        if (!hiding) setState("compacting", event.running)
        return
      case "compacted":
        return compacted(event)
      case "notice":
        if (!hiding) add({ kind: "system", id: newId("system"), text: event.text, level: event.level }, null)
        return
      case "user":
        return addUser(event, false)
      case "interrupt":
        return interrupt(event)
      case "reset":
        return reset()
      case "starting":
        return restart()
      case "ended":
        if (event.final) setState("final", true)
        return end(event.problem)
      case "seen":
        return
      case "lists": {
        const { modes, models, ...rest } = event.lists
        if (modes) setState("modes", modes)
        if (models) setState("models", models)
        push(rest)
        return
      }
      case "model":
        // Kept as a copy: the store merges a new model into the object it holds, which would change the earlier event's.
        setState("model", event.model && { ...event.model })
        return
      case "effort":
        setState("effort", event.effort)
        return
      case "plan":
        return ownPlan(event)
      case "todos":
        if (!hiding) setState("todos", structuredClone(event.items))
        return
      // Not handled yet: nothing sends them yet, or a later stage handles them.
      case "held":
      case "extraEffort":
      case "account":
      case "workflow.draft":
        return
      case "cut":
        return cutElsewhere(event.before)
      case "cut.undone":
        return redo()
      case "cut.committed":
        return commitCut()
    }
  }

  // Another client cut the conversation: the span hides as a rewind that kept the files would hide it. One already
  // hidden only moves where it starts, and keeps the files our rewind put back.
  function cutElsewhere(before: PromptId): void {
    let userId: ItemId | undefined
    let count = 0
    for (const id of state.items.toReversed()) {
      const item = state.byId[id]
      if (item?.kind !== "user") continue
      count += 1
      if (item.uuid !== before) continue
      userId = id
      break
    }
    if (userId === undefined || userId === state.rewound?.userId) return
    const kept = state.rewound ?? { files: [], keptFiles: true, last: state.items.at(-1) }
    setState("rewound", { ...kept, userId, prompts: count })
  }

  // The hidden prompts go for good.
  function commitCut(): void {
    const span = hiddenSpan(state.items, state.rewound)
    if (span) setState("items", [...state.items.slice(0, span.start), ...state.items.slice(span.end)])
    if (state.rewound) setState("rewound", null)
  }

  function redo(): void {
    setState("rewound", null)
    // A task we stopped may still bring its turn; one still running belongs to the conversation again.
    for (const id of hideFor) if (state.tasks[id]?.state === "running") hideFor.delete(id)
  }

  function openAsk(ask: AgentAsk): void {
    const agent = ask.by ? state.tasks[ask.by]?.name : undefined
    add(
      {
        kind: "ask",
        id: `ask-${ask.id}`,
        requestId: ask.id,
        toolUseId: ask.call ?? "",
        toolName: ask.tool.name,
        toolKind: ask.tool.kind,
        server: ask.tool.mcp?.server ?? null,
        displayName: ask.title,
        input: ask.input,
        target: ask.target,
        writes: [...ask.writes],
        description: ask.detail,
        reason: ask.reason,
        options: structuredClone(ask.options),
        questions: structuredClone(ask.questions),
        plan: ask.plan ? { ...ask.plan } : null,
        defaultToNo: ask.defaultNo,
        safetyCheck: ask.safety,
        status: "pending",
        answers: {},
        notes: {},
        denial: "",
        why: null,
        note: "",
        ...(agent ? { agent } : {}),
        ...(ask.own ? { mcp: { rpcId: ask.own.handle } } : {}),
      },
      null,
    )
  }

  // The plan band for a plan that came without an ask. An earlier one still open gives way to it.
  function ownPlan(event: Extract<AgentEvent, { type: "plan" }>): void {
    if (hiding) return
    for (const id of state.items) {
      const item = state.byId[id]
      if (item?.kind === "ask" && item.ownPlan && item.status === "pending")
        closeAsk(item.requestId, { status: "cancelled" })
    }
    const requestId = newId("plan")
    add(
      {
        kind: "ask",
        id: `ask-${requestId}`,
        requestId,
        toolUseId: "",
        toolName: "",
        toolKind: "plan",
        server: null,
        displayName: "",
        input: null,
        target: event.path ?? "",
        writes: [],
        description: "",
        reason: "",
        options: [planOption("yes", "allow"), planOption("no", "deny")],
        questions: null,
        plan: { text: event.text ?? "", path: event.path },
        defaultToNo: false,
        safetyCheck: false,
        status: "pending",
        answers: {},
        notes: {},
        denial: "",
        why: null,
        note: "",
        ownPlan: { next: event.next },
      },
      null,
    )
  }

  // The first outcome settles the ask; in replay that is the user's own, and the recorded one comes after.
  function closeAsk(id: AskId, outcome: AskOutcome): void {
    update(`ask-${id}`, (item) => {
      if (item.kind !== "ask" || item.status !== "pending") return
      item.status = outcome.status
      item.answers = outcome.status === "answered" ? outcome.answers : {}
      item.notes = outcome.status === "answered" ? outcome.notes : {}
      item.denial = outcome.status === "denied" ? outcome.said : ""
      item.why = outcome.status === "denied" ? outcome.why : null
      item.note = outcome.status === "denied" ? outcome.note : ""
    })
  }

  function endTool(event: Extract<AgentEvent, { type: "tool.end" }>): void {
    if (hiddenTool(event.id)) return
    for (const file of event.files) {
      const before = file.before
      if (before !== undefined) for (const listener of originalListeners) listener(event.id, file.path, before)
    }
    const tool = state.byId[event.id]
    // A call read back from a transcript saw no task start; its result still names the task.
    const taskId = (tool?.kind === "tool" && tool.taskId) || event.task
    if (tool?.kind === "tool" && !tool.taskId && taskId)
      update(tool.id, (item) => {
        if (item.kind === "tool") item.taskId = taskId
      })
    const task = tool?.kind === "tool" && taskId ? state.tasks[taskId] : undefined
    const parent = toolParents.get(event.id)
    const parentItem = parent ? state.byId[parent] : undefined
    const agentStopped = parentItem?.kind === "tool" && parentItem.agent?.state === "stopped"
    update(event.id, (item) => {
      if (item.kind !== "tool") return
      // An interrupt or a stop of its agent stops the tool; the agent's own wording of it is meant for the model.
      if (event.status === "stopped" || (agentStopped && event.status === "error")) {
        item.status = "stopped"
        item.result = ""
        if (item.agent) {
          item.agent.state = "stopped"
          item.agent.stoppedByUser = true
        }
        return
      }
      // A background task's call only says it launched; its outcome comes with the task.
      const launched = event.status === "done" && (task?.background === true || event.background)
      item.status = launched && task ? toolStatus(task.state) : event.status
      item.result = event.result
      item.images = event.images
      if (event.patch) item.patch = event.patch
      if (event.created) item.createdFile = true
      if (event.content !== null) item.content = event.content
      if (event.unchanged) item.unchanged = true
      item.count = event.count
      item.outcome = event.outcome
      item.files = event.files.map(({ path, change, movedTo, patch, after }) => ({
        path,
        change,
        movedTo,
        patch,
        after,
      }))
      if (item.agent && !launched) {
        // An agent the user stopped ends with an error result, and it stays stopped.
        if (item.agent.state !== "stopped") item.agent.state = event.status === "error" ? "failed" : "completed"
        item.agent.report = item.result
      }
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

  function endTurn(event: Event<"turn.end">): void {
    // The hidden turn's end is not shown either.
    if (hiding) {
      hiding = false
      return
    }
    settleTurn()
    const interrupted = state.interrupting || event.interrupted
    if (interrupted) cutLastText()
    // An interrupt ends its turn with an error, which is no error to the user.
    const error = interrupted ? null : event.error
    const retries = event.error !== null && retryId ? retryAttempt : 0
    dropRetry()
    retryAttempt = 0
    // A local command (/context, /compact, /clear) made no model turn to time; one that failed still says why.
    if (!event.local || event.error !== null)
      add(
        {
          kind: "turn-end",
          id: newId("turn"),
          costUsd: event.sessionCostUsd ?? 0,
          durationMs: event.durationMs,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          error,
          retries,
          interrupted,
          endedAt: now,
        },
        null,
      )
    setState("interrupting", false)
    setState("compacting", false)
    const { tokens, sessionCostUsd } = event
    setState(
      "usage",
      produce((current) => {
        current.tokens += tokens
        if (sessionCostUsd !== null) current.costUsd = sessionCostUsd
      }),
    )
    for (const prompt of event.prompts) settleQueued(prompt)
    setState("turn", null)
    // A message still queued runs next, so the session keeps running.
    setState("status", waiting.size > 0 ? "running" : "idle")
  }

  // The agent asks its model again; a turn it starts itself (a queued message, a background task's end) runs like any
  // other, and one that takes in a prompt counts as the user's.
  function stepTurn(taken: PromptId[]): void {
    if (hiding) return
    for (const prompt of taken) settleQueued(prompt)
    if (state.turn === null) setState("interrupting", false)
    if (taken.length > 0) setState("turn", "user")
    else if (state.turn === null) setState("turn", "claude")
    if (state.status === "idle") setState("status", "running")
  }

  function settleQueued(prompt: PromptId): void {
    const id = waiting.get(prompt)
    if (!id) return
    waiting.delete(prompt)
    update(id, (item) => {
      if (item.kind === "user") item.queue = null
    })
  }

  // A prompt the agent dropped before taking it in; with no turn and nothing else waiting, the session is idle.
  function dropQueued(prompt: PromptId): void {
    early.delete(prompt)
    const id = waiting.get(prompt)
    if (!id) return
    waiting.delete(prompt)
    update(id, (item) => {
      if (item.kind === "user") item.queue = "not sent"
    })
    if (state.turn === null && waiting.size === 0) setState("status", "idle")
  }

  const shifted = (window: { utilization: number; resetsAt: number }): Window => ({
    utilization: window.utilization,
    resetsAt: window.resetsAt + shift,
  })

  // The Session keeps only the 5-hour and weekly account windows; other lengths are dropped.
  function limits(event: Event<"limits">): void {
    const warning = event.warning
    setState(
      "usage",
      produce((usage) => {
        for (const window of event.windows) {
          if (window.model !== null) usage.limits.models[window.model] = shifted(window)
          else if (window.minutes === FIVE_HOURS) usage.limits.fiveHour = shifted(window)
          else if (window.minutes === WEEK) usage.limits.week = shifted(window)
        }
        usage.warning = warning && {
          status: warning.status,
          type: warning.type,
          resetsAt: warning.resetsAt === null ? 0 : warning.resetsAt + shift,
        }
      }),
    )
  }

  function compacted(event: Event<"compacted">): void {
    const { before, after } = event
    const tokens = before === null ? undefined : { before, after: after ?? undefined }
    add({ kind: "system", id: newId("system"), text: "context compacted", level: "info", tokens }, null)
    setState("compacting", false)
    if (after !== null) setState("usage", "context", "used", after)
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

  // A parent the agent no longer tracks, or never told us about, counts as no parent.
  const knownParent = (id: TaskId | null) => (id && state.tasks[id] ? id : null)

  function startTask(event: Extract<AgentEvent, { type: "task.start" }>): void {
    const tool = event.call ? state.byId[event.call] : undefined
    const known = state.tasks[event.id] ?? blankTask(event.id)
    const parentId = knownParent(event.parent) ?? known.parentId
    const earlier = known.toolUseId ? state.byId[known.toolUseId] : undefined
    const resumes = event.resumed && tool?.kind === "tool" && earlier?.kind === "tool" && !!earlier.agent
    if (resumes && earlier.agent) {
      const agent: Agent = {
        ...earlier.agent,
        prompt: event.prompt,
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
      type: event.taskType,
      kind: event.kind,
      toolUseId: event.call,
      parentId,
      depth: event.depth ?? (parentId ? (state.tasks[parentId]?.depth ?? 0) + 1 : 1),
      state: "running" as const,
      name:
        (tool?.kind === "tool" ? tool.agent?.name : undefined) ??
        (resumes ? known.name : undefined) ??
        event.description,
      description: event.description,
      prompt: event.prompt,
      workflowName: event.workflow,
      startedAt: now + shift,
      command: (tool && commands.get(tool.id)) || known.command,
    }
    task.background ||= event.background || resumes
    setState("tasks", event.id, task)
    const agentType = event.agentType
    updateTool(task, (item) => {
      item.taskId = task.id
      if (!item.agent) return
      item.agent.prompt ||= task.prompt
      item.agent.type ||= agentType
    })
  }

  function taskProgress(event: Extract<AgentEvent, { type: "task.progress" }>): void {
    // Progress that arrives after the end would replace the final numbers.
    if (state.tasks[event.id]?.state !== "running") return
    const { activity, lastTool, toolUses, durationMs, tokens } = event
    setTask(event.id, (task) => {
      task.activity = activity
      task.lastTool = lastTool
      task.toolUses = toolUses
      task.durationMs = durationMs
      task.tokens = tokens ?? task.tokens
    })
    updateTool(state.tasks[event.id], (tool) => {
      if (!tool.agent) return
      tool.agent.activity = activity
      tool.agent.toolUses = toolUses
      tool.agent.durationMs = durationMs
      tool.agent.tokens = tokens ?? tool.agent.tokens
    })
  }

  function workflowProgress(event: Extract<AgentEvent, { type: "workflow" }>): void {
    const progress = event.progress
    if (state.tasks[event.task]?.state !== "running") return
    const agents = progress.agents.map((agent) => ({
      ...agent,
      startedAt: agent.startedAt === null ? null : agent.startedAt + shift,
    }))
    setTask(event.task, (task) => (task.workflow = { phases: progress.phases, agents }))
  }

  function updateTask(event: Extract<AgentEvent, { type: "task.update" }>): void {
    const { error, background } = event
    setTask(event.id, (task) => {
      if (error) task.error = error
      if (background) task.background = true
    })
    updateTool(state.tasks[event.id], (tool) => {
      if (tool.agent && error) tool.agent.error = error
    })
  }

  function taskOutput(event: Extract<AgentEvent, { type: "task.output" }>): void {
    const { text, bytes, truncated } = event
    setTask(event.id, (task) => {
      // A shell's output only grows, so a smaller tail is a late reply to an older read.
      if (bytes < task.outputBytes) return
      task.output = text
      task.outputBytes = bytes
      task.truncated = truncated
    })
  }

  function endTask(event: Extract<AgentEvent, { type: "task.end" }>): void {
    const { id, report, call } = event
    const usage = report?.usage
    if (report) {
      setTask(id, (task) => {
        task.summary = report.summary
        task.outputFile = report.outputFile
        task.exitCode = report.exitCode
        if (usage) {
          task.toolUses = usage.toolUses
          task.durationMs = usage.durationMs
          task.tokens = usage.tokens ?? task.tokens
        }
      })
      updateTool(state.tasks[id], (tool) => {
        if (!tool.agent) return
        tool.agent.report = report.summary
        if (usage) {
          tool.agent.toolUses = usage.toolUses
          tool.agent.durationMs = usage.durationMs
          tool.agent.tokens = usage.tokens ?? tool.agent.tokens
        }
      })
    }
    finishTask(id, event.state)
    if (!report) return
    if (report.stoppedByUser)
      update(state.tasks[id]?.toolUseId ?? call ?? "", (item) => {
        if (item.kind === "tool" && item.agent) item.agent.stoppedByUser = true
      })
    // A task this session never saw start (a call read back from a transcript) still ends its call.
    if (!state.tasks[id] && call)
      update(call, (item) => {
        if (item.kind !== "tool") return
        if (item.status === "running") item.status = toolStatus(event.state)
        if (!item.agent) return
        item.agent.state = event.state
        item.agent.report = report.summary
      })
    const task = state.tasks[id]
    // A background shell's end gets a row of its own.
    if (task?.background && task.kind === "shell" && !shellEnds.has(id)) {
      shellEnds.add(id)
      add({ kind: "shell-end", id: newId("shell-end"), taskId: id }, null)
    }
  }

  // A turn the agent starts by itself, with no prompt, because a task from the rewound prompts ended is not shown.
  // Every turn uses up the ends before it, so each task hides one turn at most.
  function openTurn(event: Extract<AgentEvent, { type: "turn.open" }>): void {
    const endedTasks = event.endedTasks
    const last = endedTasks.at(-1)
    const ours =
      event.prompts.length === 0 &&
      last !== undefined &&
      hideFor.has(last) &&
      state.turn === null &&
      waiting.size === 0 &&
      early.size === 0
    for (const id of endedTasks) hideFor.delete(id)
    if (!ours) return
    hiding = true
    log.info("hiding a turn the agent started by itself")
    onHiddenStart?.()
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

  function backgroundTasks(tasks: BackgroundTask[]): void {
    const next = new Set<TaskId>()
    for (const entry of tasks) {
      next.add(entry.id)
      const known = state.tasks[entry.id]
      const task = known ?? {
        ...blankTask(entry.id),
        type: entry.taskType,
        kind: entry.kind,
        name: entry.description,
        description: entry.description,
      }
      const parentId = knownParent(entry.parent) ?? task.parentId
      setState("tasks", entry.id, { ...task, background: true, parentId })
    }
    // A task that leaves the live set without an end was lost; it no longer runs.
    for (const id of live) if (!next.has(id) && state.tasks[id]?.state === "running") finishTask(id, "stopped")
    live = next
  }

  // The agent is gone, and with it the calls our own asks would answer.
  function cancelOwnAsks(): void {
    for (const item of Object.values(state.byId)) {
      if (item.kind !== "ask" || !item.mcp || item.status !== "pending") continue
      update(item.id, (ask) => {
        if (ask.kind === "ask") ask.status = "cancelled"
      })
    }
  }

  function addUser(user: UserPrompt, shownEarly: boolean): void {
    const { prompt } = user
    if (!shownEarly && prompt !== null && early.has(prompt)) {
      // Shown already; one that starts a turn waits for nothing once it is out.
      if (early.get(prompt)) settleQueued(prompt)
      early.delete(prompt)
      return
    }
    // A message sent after a rewind makes it final.
    commitCut()
    for (const shown of state.items) {
      const item = state.byId[shown]
      if (item?.kind === "tool" && item.local && !item.local.told)
        update(shown, (tool) => {
          if (tool.kind === "tool" && tool.local) tool.local.told = true
        })
    }
    const id = newId("user")
    // Only a message sent during a turn waits; one sent while idle starts its own turn. Prompts read back from history
    // all ran already. One shown before it goes out waits until it does, but looks queued only behind a running turn.
    const running = state.status === "running"
    const queued = (running || shownEarly) && prompt !== null && !user.history
    const to = user.to && { id: user.to.task, name: user.to.name }
    const peer = readSessionMessage(user.text)
    add(
      {
        kind: "user",
        id,
        text: peer ? peer.text : user.text,
        images: user.images,
        to,
        ...(peer && { from: { id: peer.id, title: peer.title, agent: peer.agent, broadcast: peer.broadcast } }),
        queue: queued && running ? "queued" : null,
        uuid: prompt ?? undefined,
      },
      null,
    )
    if (prompt !== null) prompts.set(prompt, id)
    if (queued && prompt !== null) waiting.set(prompt, id)
    if (shownEarly && prompt !== null) early.set(prompt, !running)
    if (!queued || !running) setState("turn", "user")
    // A message queued during a turn keeps that turn's interrupt; a fresh turn drops one that raced the result.
    if (state.status !== "running") setState("interrupting", false)
    setState("status", "running")
  }

  function interrupt(event: Event<"interrupt">): void {
    // An interrupt asked, or answered, after its turn ended has nothing left to interrupt.
    if (event.state === "asked" && state.turn !== null) setState("interrupting", true)
    else if (event.state === "refused" || (event.state === "answered" && state.turn === null))
      setState("interrupting", false)
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

  // The chat starts over; the /clear's own result is still to come. Messages sent after the /clear that the agent has
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
      if (item?.kind !== "tool") return false
      if (item.agent === null && item.toolKind !== "agent" && item.toolKind !== "workflow") return false
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
    for (const id of toolParents.keys()) if (!kept.has(id)) toolParents.delete(id)
    for (const id of commands.keys()) if (!kept.has(id)) commands.delete(id)
    for (const id of thinkingSince.keys()) if (!kept.has(id)) thinkingSince.delete(id)
    for (const [part, known] of parts) if (!kept.has(known.id)) parts.delete(part)
    for (const [prompt, id] of prompts) if (!kept.has(id)) prompts.delete(prompt)
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

  // The agent starts again on the same session; the chat stays as it was.
  function restart(): void {
    hiding = false
    hideFor.clear()
    cancelOwnAsks()
    setState("status", "starting")
  }

  // With a problem, the agent went away on its own: running work stops and the chat ends with an error row.
  function end(problem: SessionEnd | null): void {
    for (const id of Object.keys(state.byId)) stopStreaming(id)
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
  }

  function tick(at: number) {
    now = at
    shift = Date.now() - at
    if (state.usage.startedAt === null) setState("usage", "startedAt", Date.now())
  }

  return {
    state,
    lists,
    event(event) {
      // A start or end of the agent alone keeps the clock of the last event and does not start the session's.
      if (event.type !== "starting" && event.type !== "ended") tick(event.at)
      onEvent(event)
    },
    prepend(events) {
      const earlier = createSession({ idPrefix: `p${++prepends}-` })
      for (const event of events) earlier.event(event)
      earlier.stopRunning()
      setState("byId", earlier.state.byId)
      setState("items", (ids) => [...earlier.state.items, ...ids])
    },
    startShell(command, told) {
      const id = newId("shell")
      add(
        {
          kind: "tool",
          id,
          name: "Bash",
          toolKind: "shell",
          title: "Bash",
          server: null,
          inputText: "",
          input: { command },
          summary: command,
          detail: null,
          background: false,
          status: "running",
          result: "",
          children: [],
          patch: null,
          createdFile: false,
          content: null,
          images: [],
          unchanged: false,
          count: null,
          files: [],
          questions: null,
          outcome: null,
          agent: null,
          taskId: null,
          local: { told },
        },
        null,
      )
      return id
    },
    shellOutput(id, output) {
      update(id, (item) => {
        if (item.kind === "tool") item.result = output
      })
    },
    endShell(id, output, code, stopped) {
      update(id, (item) => {
        if (item.kind !== "tool") return
        const failed = !stopped && code !== 0
        item.result = failed
          ? `${output}${output && !output.endsWith("\n") ? "\n" : ""}exit code ${code ?? "?"}`
          : output
        item.status = stopped ? "stopped" : failed ? "error" : "done"
      })
    },
    rewind(rewound) {
      setState("rewound", { ...rewound, last: rewound.last ?? state.items.at(-1) })
    },
    redo,
    onFileOriginal(listener) {
      originalListeners.push(listener)
    },
    hideTurnsOf(taskIds, onStart) {
      for (const id of taskIds) hideFor.add(id)
      onHiddenStart = onStart
    },
    showEarly(prompt) {
      addUser(prompt, true)
    },
    notSent(prompt) {
      const startsTurn = early.get(prompt)
      early.delete(prompt)
      const id = waiting.get(prompt)
      if (!id) return
      waiting.delete(prompt)
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
    setLists(next) {
      if (next.mcpServers !== undefined) setState("mcpServers", next.mcpServers)
      if (next.plugins !== undefined) setState("plugins", next.plugins)
      if (next.mcp !== undefined) push({ mcp: next.mcp })
    },
    setPermissionMode(mode) {
      setState("permissionMode", mode)
    },
    settlePlan(id, reply) {
      closeAsk(
        id,
        reply.type === "option" && reply.option === "yes"
          ? { status: "allowed" }
          : { status: "denied", said: "", why: "declined", note: "" },
      )
    },
    interrupting() {
      if (state.turn !== null) setState("interrupting", true)
    },
  }
}

// A session read back to be looked at, not continued: what it left running shows as stopped, and it ends there.
export function loadHistory(session: SessionStore, events: AgentEvent[]): void {
  for (const event of events) session.event(event)
  session.stopRunning()
  session.event({ type: "ended", problem: null, at: Date.now() })
}
