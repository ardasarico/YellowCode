// Codex's notifications and stored turns as neutral events, for one thread and the subagents it spawns. Live and
// read-back turns go through the same item handling. A subagent runs in a thread of its own; its items are told under
// the call that spawned it, and its turns make its task.
import type { AgentEvent } from "../../agent/events.ts"
import type { ModeId, PartId, PromptId, TaskId, ToolId } from "../../agent/ids.ts"
import type { Image, Todo } from "../../agent/tools.ts"
import { oneLine } from "../../session/tool-summary.ts"
import { blankEnd, callOf, calledOf, endOf, isTool, mediaOf, type Call, type ToolItem } from "./tools.ts"
import { createMeter, limitsOf, type Meter } from "./usage.ts"
import type { ThreadItem } from "./wire/items.ts"
import type { Notification } from "./wire/notifications.ts"
import type { Turn } from "./wire/thread.ts"

type Events = AgentEvent[]
type UserMessage = Extract<ThreadItem, { type: "userMessage" }>
type Reasoning = Extract<ThreadItem, { type: "reasoning" }>
type Collab = Extract<ThreadItem, { type: "collabAgentToolCall" }>
type TaskState = Extract<AgentEvent, { type: "task.end" }>["state"]

// A prompt is the client's id when it sent one (ours are YellowCode's PromptIds), the item's otherwise.
export const promptOf = (item: UserMessage): PromptId => item.clientId ?? item.id

const textOf = (item: UserMessage) =>
  item.content.flatMap((input) => (input.type === "text" && input.text !== undefined ? [input.text] : [])).join("\n")

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

// Ours go as `data:` urls; another client's may name a file.
function imagesOf(item: UserMessage): Image[] {
  const images: Image[] = []
  for (const input of item.content) {
    const name = `Image ${images.length + 1}`
    const data = input.type === "image" && input.url !== undefined ? DATA_URL.exec(input.url) : null
    if (data) images.push({ name, mediaType: data[1] ?? "image/png", data: data[2] ?? "", path: null })
    else if (input.type === "localImage" && input.path !== undefined)
      images.push({ name, mediaType: mediaOf(input.path), data: null, path: input.path })
  }
  return images
}

// Item notifications, told the same way for the main thread and a subagent's.
const SHARED = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/mcpToolCall/progress",
  "item/fileChange/patchUpdated",
] as const
type Shared = Extract<Notification, { method: (typeof SHARED)[number] }>
type Own = Exclude<Notification, Shared>
const sharedMethods: ReadonlySet<string> = new Set(SHARED)
const isShared = (notification: Notification): notification is Shared => sharedMethods.has(notification.method)

const stamp = (events: Events, at: number): Events => events.map((event) => ({ ...event, at }))

// A subagent, by its thread, which is also its task's id. `call` is the call its work goes under: the spawn, or a
// message that woke it up again.
type Child = {
  thread: string
  call: ToolId
  parent: TaskId | null
  startedAt: number
  toolUses: number
  // Its last words, which are its report.
  said: string
  ended: boolean
  // Its turn that runs, and whether the user stopped it.
  turn: string | null
  stopping: boolean
}

// Where an item is told: the main thread, or a subagent's under its call.
type Scope = { thread: string; parent: ToolId | null; child: Child | null }

type Part = {
  thread: string
  kind: "text" | "thinking"
  open: boolean
  source: "summary" | "content" | null
  index: number
}

type Tool = { thread: string; item: ToolItem; call: Call; told: string; output: string; ended: boolean }

// A command that runs on in the background after its turn: the process Codex keeps it in.
type Shell = { process: string; stopping: boolean; ended: boolean }

// A background terminal as Codex lists it.
export type Terminal = { itemId: string; processId: string; command: string }

// Codex's states of a subagent that has stopped working.
const FINAL: Record<string, TaskState> = {
  completed: "completed",
  errored: "failed",
  notFound: "failed",
  interrupted: "stopped",
  shutdown: "stopped",
}

// Calls that give a subagent more work.
const WAKES = new Set(["sendInput", "sendMessage", "followupTask", "resumeAgent"])

const TURN_STATES: Record<string, TaskState> = { completed: "completed", failed: "failed", interrupted: "stopped" }

const STEP_STATES: Record<string, Todo["state"]> = { pending: "pending", inProgress: "running", completed: "done" }

// Codex's error kinds by the retry reasons the chat knows.
const REASONS: Record<string, string> = {
  serverOverloaded: "overloaded",
  rateLimitExceeded: "rate_limit",
  usageLimitExceeded: "rate_limit",
  internalServerError: "server_error",
  unauthorized: "authentication_failed",
}

// `codexErrorInfo` is a plain kind, or one kind with the HTTP status under it.
function retryOf(info: unknown): { reason: string; status: number | null } {
  if (typeof info === "string") return { reason: REASONS[info] ?? info, status: null }
  if (typeof info !== "object" || info === null) return { reason: "", status: null }
  const entries: [string, unknown][] = Object.entries(info)
  const [kind, inner] = entries[0] ?? ["", null]
  const code = typeof inner === "object" && inner !== null && "httpStatusCode" in inner ? inner.httpStatusCode : null
  const status = typeof code === "number" ? code : null
  return { reason: REASONS[kind] ?? kind, status }
}

// The turn that runs: whether a prompt opened it yet, the error Codex gave up with, the retries so far, the plan it
// finished, and whether it compacted the context.
type Running = {
  id: string
  prompted: boolean
  error: string | null
  retries: number
  plan: string | null
  compacted: boolean
}

const opening = (id: string): Running => ({
  id,
  prompted: false,
  error: null,
  retries: 0,
  plan: null,
  compacted: false,
})

export type Translator = {
  notification(notification: Notification, at: number): Events
  // Stored turns, oldest first, as the chat shows a session's past: every prompt from history, every item done. Only
  // a turn that did not go well ends with a row.
  readBack(turns: Turn[]): Events
  // The turn that runs now.
  running(): string | null
  // The main thread is now `thread`, a copy of the one before.
  moved(thread: string): void
  // The turn a prompt of this session went into, when it was seen live.
  turnOf(prompt: PromptId): string | null
  // The prompts seen live after the newest turn `kept` (null: none is kept), or from the turn `from` on, oldest first;
  // they are forgotten.
  cutAfter(kept: string | null): PromptId[]
  cutFrom(from: string): PromptId[]
  // Main-thread commands still running as their turn ends; `backgrounded` says which of them Codex runs on.
  lingering(): ToolId[]
  backgrounded(terminals: Terminal[], at: number): Events
  // A background shell's process, by its task.
  shell(task: TaskId): string | null
  stopping(task: TaskId, at: number): Events
  // The stop did not go through: the task's end is its own again.
  refused(task: TaskId): void
  // The subagent's turn that runs now.
  childTurn(task: TaskId): string | null
  // The connection is gone: what was open stays as it streamed.
  gone(at: number): Events
  // The main thread's context, as its usage updates tell it.
  meter: Meter
  // A /compact went out: the turn Codex starts for it shows `prompt`, and ends with no row of its own. Null takes it
  // back.
  compacting(prompt: { id: PromptId; text: string } | null): void
  // A call as it stands now, for an ask about it.
  item(id: ToolId): ToolItem | null
  // The subagent a thread is, null for the main thread or one not known.
  subagent(thread: string): TaskId | null
  // The newest MCP call of `server` in `thread` that has not ended.
  mcpCall(thread: string, server: string): ToolId | null
}

// `cwd`: the session's folder, for paths Codex gives relative. `provider`: the session's, for a model Codex moves to.
// `afterPlan`: the mode a finished plan goes on in.
export function createTranslator(
  opened: string,
  options: { cwd: string | null; provider: string | null; afterPlan?: () => ModeId | null } = {
    cwd: null,
    provider: null,
  },
): Translator {
  const { cwd } = options
  // The main thread, which a cut in a legacy thread moves to its copy.
  let thread = opened
  const main: Scope = { thread, parent: null, child: null }
  const users = new Set<string>()
  const parts = new Map<PartId, Part>()
  const tools = new Map<ToolId, Tool>()
  const children = new Map<string, Child>()
  // Spawn calls whose thread is not known yet, in spawn order.
  const spawning: { call: ToolId; scope: Scope }[] = []
  // Subagents that ended between turns, for the next turn to take in.
  let ended: TaskId[] = []
  // Prompts seen live, oldest first, with their turns.
  let prompts: { prompt: PromptId; turn: string }[] = []
  const shells = new Map<ToolId, Shell>()
  let turn: Running | null = null
  let now = 0
  const meter = createMeter()
  // The /compact that waits for its turn, and the compaction that runs, with the context before it and after.
  let asked: { id: PromptId; text: string } | null = null
  let compaction: { before: number | null; after: number | null } | null = null

  function user(item: UserMessage, history: boolean, first: boolean): Events {
    if (users.has(item.id)) return []
    users.add(item.id)
    const images = imagesOf(item)
    return [
      { type: "user", prompt: promptOf(item), text: textOf(item), images, to: null, history, cutPoint: first, at: 0 },
    ]
  }

  function partStart(id: PartId, kind: Part["kind"], text: string, live: boolean, scope: Scope): Events {
    if (parts.has(id)) return []
    parts.set(id, { thread: scope.thread, kind, open: true, source: null, index: 0 })
    const parent = scope.parent
    return kind === "text"
      ? [{ type: "text.start", part: id, parent, text, local: false, quiet: false, at: 0 }]
      : [{ type: "thinking.start", part: id, parent, text, live, at: 0 }]
  }

  function partDelta(id: PartId, text: string, scope: Scope): Events {
    const known = parts.get(id)
    if (!known) return partStart(id, "text", text, true, scope)
    return known.open ? [{ type: "text.delta", part: id, text, at: 0 }] : []
  }

  // A part told whole was never streamed; one that streamed ends with the item's text.
  function partEnd(id: PartId, kind: Part["kind"], text: string | null, scope: Scope): Events {
    const known = parts.get(id)
    if (known && !known.open) return []
    const started = known ? [] : partStart(id, kind, text ?? "", false, scope)
    const part = parts.get(id)
    if (part) part.open = false
    const final = known ? text : null
    return [
      ...started,
      kind === "text"
        ? { type: "text.end", part: id, text: final, at: 0 }
        : { type: "thinking.end", part: id, text: final, at: 0 },
    ]
  }

  function forget(at: number): PromptId[] {
    const cut = prompts.slice(at).map((seen) => seen.prompt)
    prompts = prompts.slice(0, at)
    return cut
  }

  function endParts(of: string | null): Events {
    const events: Events = []
    for (const [id, known] of parts) {
      if (!known.open || (of !== null && known.thread !== of)) continue
      known.open = false
      events.push(
        known.kind === "text"
          ? { type: "text.end", part: id, text: null, at: 0 }
          : { type: "thinking.end", part: id, text: null, at: 0 },
      )
    }
    return events
  }

  // Summary parts, or the raw reasoning when Codex gives no summary, stream into one thinking block.
  function reasoningDelta(
    id: PartId,
    text: string,
    source: "summary" | "content",
    index: number,
    scope: Scope,
  ): Events {
    const known = parts.get(id)
    if (!known) {
      const events = partStart(id, "thinking", text, true, scope)
      const part = parts.get(id)
      if (part) Object.assign(part, { source, index })
      return events
    }
    if (!known.open || (known.source !== null && known.source !== source)) return []
    const gap = index > known.index ? "\n\n" : ""
    Object.assign(known, { source, index })
    return [{ type: "thinking.delta", part: id, text: gap + text, at: 0 }]
  }

  function reasoningEnd(item: Reasoning, scope: Scope): Events {
    const text = item.summary.length > 0 ? item.summary.join("\n\n") : item.content.join("\n\n")
    if (!parts.has(item.id) && text === "") return []
    return partEnd(item.id, "thinking", text, scope)
  }

  function acted(child: Child, call: Call): Events {
    child.toolUses += 1
    const activity = call.summary ? `${call.title} ${call.summary}` : call.title
    const { toolUses } = child
    const durationMs = Math.max(0, now - child.startedAt)
    return [
      {
        type: "task.progress",
        id: child.thread,
        activity,
        lastTool: call.name,
        toolUses,
        durationMs,
        tokens: null,
        at: 0,
      },
    ]
  }

  function toolStart(item: ToolItem, scope: Scope): Events {
    if (tools.has(item.id)) return []
    const call = callOf(item, cwd)
    tools.set(item.id, { thread: scope.thread, item, call, told: JSON.stringify(call), output: "", ended: false })
    if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") spawning.push({ call: item.id, scope })
    if (item.type === "collabAgentToolCall") woken(item)
    const { name, kind, title, mcp } = call
    return [
      { type: "tool.start", id: item.id, parent: scope.parent, name, kind, title, mcp, quiet: false, at: 0 },
      calledOf(item.id, call),
      ...(scope.child ? acted(scope.child, call) : []),
    ]
  }

  // The call as the item has it now; told again only when it changed.
  function toolUpdate(item: ToolItem, scope: Scope): Events {
    const known = tools.get(item.id)
    if (!known) return toolStart(item, scope)
    known.item = item
    const call = callOf(item, cwd)
    const told = JSON.stringify(call)
    if (told === known.told) return []
    Object.assign(known, { call, told })
    return [calledOf(item.id, call)]
  }

  function toolOutput(id: ToolId, text: string, replace: boolean): Events {
    const known = tools.get(id)
    if (!known || known.ended) return []
    known.output = replace ? text : known.output + text
    return [{ type: "tool.output", id, text: known.output, at: 0 }]
  }

  function toolEnd(item: ToolItem, scope: Scope): Events {
    const shell = shells.get(item.id)
    if (shell && item.type === "commandExecution") return shellEnd(item.id, shell, item.exitCode ?? null)
    const started = toolUpdate(item, scope)
    const known = tools.get(item.id)
    if (!known || known.ended) return started
    known.ended = true
    const end = endOf(item, known.call, known.output, cwd)
    const tasks = item.type === "collabAgentToolCall" ? collabDone(item, scope) : []
    return [...started, ...tasks, end, ...(item.type === "collabAgentToolCall" ? statesOf(item) : [])]
  }

  // Calls of `of` still open when its turn ended, as an interrupt leaves them.
  function stopTools(of: string): Events {
    const events: Events = []
    for (const [id, known] of tools) {
      if (known.ended || known.thread !== of) continue
      known.ended = true
      events.push(blankEnd(id, "stopped", known.output))
    }
    return events
  }

  // The chat reads a shell's exit code from the end of its summary.
  function shellEnd(id: ToolId, shell: Shell, exitCode: number | null): Events {
    if (shell.ended) return []
    shell.ended = true
    const state = shell.stopping ? "stopped" : exitCode === 0 ? "completed" : "failed"
    const summary = exitCode === null ? "" : `exit code ${exitCode}`
    const report = { summary, outputFile: null, usage: null, stoppedByUser: shell.stopping }
    return [{ type: "task.end", id, state, report, call: id, at: 0 }]
  }

  function taskStart(child: Child, prompt: string, resumed: boolean): AgentEvent {
    return {
      type: "task.start",
      id: child.thread,
      kind: "agent",
      taskType: "local_agent",
      call: child.call,
      parent: child.parent,
      depth: null,
      background: true,
      resumed,
      description: oneLine(prompt.split("\n")[0]),
      prompt,
      workflow: "",
      agentType: "",
      at: 0,
    }
  }

  function childStart(id: string, call: ToolId, scope: Scope, prompt: string): Events {
    const parent = scope.child?.thread ?? null
    const child: Child = {
      thread: id,
      call,
      parent,
      startedAt: now,
      toolUses: 0,
      said: "",
      ended: false,
      turn: null,
      stopping: false,
    }
    children.set(id, child)
    return [taskStart(child, prompt, false)]
  }

  function childEnd(child: Child, state: TaskState, summary: string): Events {
    if (child.ended) return []
    child.ended = true
    if (turn === null) ended.push(child.thread)
    const usage = { toolUses: child.toolUses, durationMs: Math.max(0, now - child.startedAt), tokens: null }
    const report = { summary, outputFile: null, usage, stoppedByUser: child.stopping && state === "stopped" }
    return [{ type: "task.end", id: child.thread, state, report, call: child.call, at: 0 }]
  }

  // A message to a subagent that stopped wakes it up, and its work goes on under the message.
  function woken(item: Collab): void {
    if (!WAKES.has(item.tool)) return
    for (const id of item.receiverThreadIds) {
      const child = children.get(id)
      if (child?.ended) child.call = item.id
    }
  }

  const promptOfCall = (call: ToolId) => {
    const item = tools.get(call)?.item
    return item?.type === "collabAgentToolCall" ? (item.prompt ?? "") : ""
  }

  // A spawn names its thread once it is done.
  function collabDone(item: Collab, scope: Scope): Events {
    woken(item)
    if (item.tool !== "spawnAgent") return []
    const at = spawning.findIndex((pending) => pending.call === item.id)
    if (at >= 0) spawning.splice(at, 1)
    const model = item.model ? [{ type: "subagent.model" as const, call: item.id, model: item.model, at: 0 }] : []
    const started = item.receiverThreadIds.flatMap((id) =>
      children.has(id) ? [] : childStart(id, item.id, scope, item.prompt ?? ""),
    )
    return [...started, ...model]
  }

  // What a call says of the subagents it waited on or closed.
  function statesOf(item: Collab): Events {
    return Object.entries(item.agentsStates).flatMap(([id, state]) => {
      const child = children.get(id)
      const final = FINAL[state.status]
      return child && final ? childEnd(child, final, state.message ?? child.said) : []
    })
  }

  // An item as it started (`done` false) or completed.
  function itemEvents(found: ThreadItem, done: boolean, history: boolean, scope: Scope): Events {
    if (found.type === "userMessage") {
      // A subagent's prompt is its spawn's.
      if (scope.child) return []
      const opens = turn === null || !turn.prompted
      if (turn) turn.prompted = true
      if (!history && turn) prompts.push({ prompt: promptOf(found), turn: turn.id })
      return user(found, history, opens)
    }
    if (found.type === "agentMessage") {
      if (!done) return partStart(found.id, "text", found.text, true, scope)
      if (scope.child) scope.child.said = found.text
      return partEnd(found.id, "text", found.text, scope)
    }
    if (found.type === "reasoning") return done ? reasoningEnd(found, scope) : []
    // A plan reads as text; a live one opens the band too once its turn ends well.
    if (found.type === "plan" && done && !scope.child) {
      if (!history && turn) turn.plan = found.text
      return partEnd(found.id, "text", found.text, scope)
    }
    if (isTool(found)) return done ? toolEnd(found, scope) : toolStart(found, scope)
    if (found.type === "contextCompaction" && !scope.child) return done ? compacted() : compactionStart()
    return []
  }

  function compactionStart(): Events {
    compaction = { before: meter.used() || null, after: null }
    return [{ type: "compaction", running: true, at: 0 }]
  }

  // Told once per turn, by the item or by the older notification; a stored one knows no sizes.
  function compacted(): Events {
    if (turn?.compacted) return []
    if (turn) turn.compacted = true
    const { before, after } = compaction ?? { before: null, after: null }
    compaction = null
    return [{ type: "compacted", before, after, at: 0 }]
  }

  // A turn that only compacted, as /compact starts one, gets no row.
  function endTurn(stored: Turn): Events {
    const kept = turn?.error ?? null
    const plan = stored.status === "completed" ? (turn?.plan ?? null) : null
    const local = turn !== null && !turn.prompted && turn.compacted
    turn = null
    compaction = null
    const failed = stored.status === "failed"
    const next = options.afterPlan?.() ?? null
    return [
      ...endParts(thread),
      ...stopTools(thread),
      {
        type: "turn.end",
        error: failed ? (stored.error?.message ?? kept ?? "The turn failed") : null,
        interrupted: stored.status === "interrupted",
        local,
        durationMs: stored.durationMs ?? 0,
        ...meter.turnEnd(),
        sessionCostUsd: null,
        prompts: [],
        at: 0,
      },
      ...(plan === null ? [] : [{ type: "plan" as const, text: plan, path: null, next, at: 0 }]),
    ]
  }

  function shared(notification: Shared, scope: Scope): Events {
    switch (notification.method) {
      case "item/started":
        return itemEvents(notification.params.item, false, false, scope)
      case "item/completed":
        return itemEvents(notification.params.item, true, false, scope)
      case "item/agentMessage/delta":
        return partDelta(notification.params.itemId, notification.params.delta, scope)
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta, summaryIndex } = notification.params
        return reasoningDelta(itemId, delta, "summary", summaryIndex, scope)
      }
      case "item/reasoning/textDelta": {
        const { itemId, delta, contentIndex } = notification.params
        return reasoningDelta(itemId, delta, "content", contentIndex, scope)
      }
      case "item/commandExecution/outputDelta":
        return toolOutput(notification.params.itemId, notification.params.delta, false)
      case "item/mcpToolCall/progress":
        return toolOutput(notification.params.itemId, notification.params.message, true)
      case "item/fileChange/patchUpdated": {
        const known = tools.get(notification.params.itemId)
        if (known?.item.type !== "fileChange" || known.ended) return []
        return toolUpdate({ ...known.item, changes: notification.params.changes }, scope)
      }
      // A new summary part shows by its index in the next delta.
      case "item/reasoning/summaryPartAdded":
        break
    }
    return []
  }

  function mainEvents(notification: Own): Events {
    switch (notification.method) {
      case "turn/started": {
        turn = opening(notification.params.turn.id)
        const endedTasks = ended
        ended = []
        const command = asked
        asked = null
        return [
          { type: "turn.open", prompts: [], endedTasks, at: 0 },
          { type: "turn.step", prompts: [], at: 0 },
          { type: "reply", at: 0 },
          ...(command === null
            ? []
            : [
                {
                  type: "user" as const,
                  prompt: command.id,
                  text: command.text,
                  images: [],
                  to: null,
                  history: false,
                  cutPoint: false,
                  at: 0,
                },
              ]),
        ]
      }
      case "thread/tokenUsage/updated": {
        const { tokenUsage } = notification.params
        if (compaction) compaction.after = tokenUsage.last.totalTokens
        return meter.update(tokenUsage, turn !== null)
      }
      case "account/rateLimits/updated": {
        const limits = limitsOf(notification.params.rateLimits)
        return limits ? [limits] : []
      }
      case "thread/name/updated": {
        const { threadName } = notification.params
        return threadName ? [{ type: "title", title: threadName, at: 0 }] : []
      }
      case "thread/compacted":
        return turn ? compacted() : []
      case "turn/completed":
        return turn ? endTurn(notification.params.turn) : []
      case "error": {
        const { error, willRetry } = notification.params
        if (!turn) return []
        if (!willRetry) {
          turn.error = error.message
          return []
        }
        turn.retries += 1
        const { reason, status } = retryOf(error.codexErrorInfo)
        return [{ type: "retry", attempt: turn.retries, max: null, delayMs: null, status, reason, at: 0 }]
      }
      case "warning":
        return [{ type: "notice", level: "warning", text: notification.params.message, at: 0 }]
      case "configWarning":
      case "deprecationNotice": {
        const { summary, details } = notification.params
        const text = details ? `${summary} ${details}` : summary
        const level = notification.method === "configWarning" ? "warning" : "info"
        return [{ type: "notice", level, text, at: 0 }]
      }
      case "model/rerouted": {
        const { fromModel, toModel } = notification.params
        return [
          { type: "notice", level: "info", text: `Codex moved this turn from ${fromModel} to ${toModel}`, at: 0 },
          { type: "model", model: { provider: options.provider, id: toModel }, at: 0 },
        ]
      }
      case "turn/plan/updated": {
        const items = notification.params.plan.map((step, index) => ({
          id: String(index + 1),
          text: step.step,
          state: STEP_STATES[step.status] ?? "pending",
        }))
        return [{ type: "todos", items, at: 0 }]
      }
      // Settings are the agent's to tell; a plan's text is read when its item completes.
      case "thread/settings/updated":
      case "item/plan/delta":
      case "thread/started":
      case "thread/status/changed":
      case "serverRequest/resolved":
      case "thread/reverted":
      case "thread/queue/changed":
        break
    }
    return []
  }

  // A subagent's own errors and notices are left to its turn's end.
  function childEvents(notification: Own, child: Child): Events {
    switch (notification.method) {
      case "turn/started":
        child.turn = notification.params.turn.id
        if (!child.ended) return []
        Object.assign(child, { ended: false, startedAt: now, toolUses: 0, said: "", stopping: false })
        return [taskStart(child, promptOfCall(child.call), true)]
      case "turn/completed": {
        const { status } = notification.params.turn
        child.turn = null
        const state = TURN_STATES[status] ?? "completed"
        return [...endParts(child.thread), ...stopTools(child.thread), ...childEnd(child, state, child.said)]
      }
      case "error":
      case "warning":
      case "configWarning":
      case "deprecationNotice":
      case "model/rerouted":
      case "turn/plan/updated":
      case "thread/settings/updated":
      case "item/plan/delta":
      case "thread/started":
      case "thread/status/changed":
      case "serverRequest/resolved":
      case "thread/reverted":
      case "thread/queue/changed":
      case "thread/tokenUsage/updated":
      case "account/rateLimits/updated":
      case "thread/name/updated":
      case "thread/compacted":
        break
    }
    return []
  }

  // A subagent's first turn can come before its spawn names it; children start in spawn order, so it belongs to the oldest spawn that waits.
  function link(notification: Notification, other: string): Events {
    if (notification.method !== "turn/started" || notification.params.turn.rootTurnId !== turn?.id) return []
    const pending = spawning.shift()
    if (!pending) return []
    const events = childStart(other, pending.call, pending.scope, promptOfCall(pending.call))
    const child = children.get(other)
    if (child) child.turn = notification.params.turn.id
    return events
  }

  function translate(notification: Notification): Events {
    const params: object = notification.params
    const other = "threadId" in params && typeof params.threadId === "string" ? params.threadId : null
    if (other === null || other === thread)
      return isShared(notification) ? shared(notification, main) : mainEvents(notification)
    const child = children.get(other)
    if (!child) return link(notification, other)
    if (!isShared(notification)) return childEvents(notification, child)
    return shared(notification, { thread: child.thread, parent: child.call, child })
  }

  return {
    notification(notification, at) {
      now = at
      const events = translate(notification)
      return stamp(events.length > 0 ? events : [{ type: "seen", at: 0 }], at)
    },
    readBack(turns) {
      const events: Events = []
      for (const stored of turns) {
        turn = opening(stored.id)
        now = (stored.startedAt ?? 0) * 1000
        events.push(
          ...stamp(
            stored.items.flatMap((found) => itemEvents(found, true, true, main)),
            now,
          ),
        )
        if (stored.status === "failed" || stored.status === "interrupted") {
          now = (stored.completedAt ?? stored.startedAt ?? 0) * 1000
          const end: Events = [{ type: "turn.open", prompts: [], endedTasks: [], at: 0 }, ...endTurn(stored)]
          events.push(...stamp(end, now))
        }
        turn = null
      }
      // A subagent the history never sees end ended with the turn that spawned it.
      const open = [...children.values()].flatMap((child) => childEnd(child, "completed", child.said))
      ended = []
      return [...events, ...stamp(open, now)]
    },
    running: () => turn?.id ?? null,
    moved(next) {
      thread = next
      main.thread = next
    },
    turnOf: (prompt) => prompts.find((seen) => seen.prompt === prompt)?.turn ?? null,
    cutAfter: (kept) => forget(kept === null ? 0 : prompts.findLastIndex((seen) => seen.turn === kept) + 1),
    cutFrom(from) {
      const at = prompts.findIndex((seen) => seen.turn === from)
      return forget(at < 0 ? 0 : at)
    },
    lingering: () =>
      [...tools].flatMap(([id, known]) =>
        !known.ended &&
        known.thread === thread &&
        known.item.type === "commandExecution" &&
        known.item.processId !== null &&
        known.item.processId !== undefined
          ? [id]
          : [],
      ),
    // A listed command's call ends as launched, and its task runs until the command's item completes.
    backgrounded(terminals, at) {
      const events: Events = []
      for (const terminal of terminals) {
        const known = tools.get(terminal.itemId)
        if (!known || known.ended || known.thread !== thread) continue
        known.ended = true
        shells.set(terminal.itemId, { process: terminal.processId, stopping: false, ended: false })
        events.push(
          {
            type: "task.start",
            id: terminal.itemId,
            kind: "shell",
            taskType: "local_bash",
            call: terminal.itemId,
            parent: null,
            depth: null,
            background: true,
            resumed: false,
            description: known.call.summary || terminal.command,
            prompt: "",
            workflow: "",
            agentType: "",
            at: 0,
          },
          { ...blankEnd(terminal.itemId, "done", known.output), background: true, task: terminal.itemId },
        )
      }
      return stamp(events, at)
    },
    shell: (task) => {
      const shell = shells.get(task)
      return shell && !shell.ended ? shell.process : null
    },
    stopping(task, at) {
      const known = shells.get(task) ?? children.get(task)
      if (!known) return []
      known.stopping = true
      return stamp([{ type: "task.stopping", id: task, at: 0 }], at)
    },
    refused(task) {
      const known = shells.get(task) ?? children.get(task)
      if (known) known.stopping = false
    },
    childTurn: (task) => {
      const child = children.get(task)
      return child && !child.ended ? child.turn : null
    },
    gone(at) {
      turn = null
      compaction = null
      return stamp(endParts(null), at)
    },
    meter,
    compacting(prompt) {
      asked = prompt
    },
    item: (id) => tools.get(id)?.item ?? null,
    subagent: (other) => children.get(other)?.thread ?? null,
    mcpCall(other, server) {
      const open = [...tools].filter(
        ([, known]) =>
          known.thread === other && !known.ended && known.item.type === "mcpToolCall" && known.item.server === server,
      )
      return open.at(-1)?.[0] ?? null
    },
  }
}
