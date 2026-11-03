// opencode's events of one session as neutral events. It keeps what it has told the store, so an event that arrives
// twice (live and from a resync) is told once, and a resync can tell only what was missed. A subagent's child session
// is told under the call that started it.
import { normalize } from "node:path"
import type { Prompt } from "../../agent/agent.ts"
import type { AskOutcome } from "../../agent/ask.ts"
import type { AskId, EffortId, ModeId, PartId, PromptId, TaskId, ToolId } from "../../agent/ids.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { ModelGroup } from "../../agent/lists.ts"
import type { Image } from "../../agent/tools.ts"
import { formAnswers } from "../../protocol/form-answers.ts"
import { formAsk, permissionAsk, permissionOutcome } from "./asks.ts"
import { DEFAULT_VARIANT } from "./lists.ts"
import type { Modes } from "./modes.ts"
import { inPlanFolder } from "./plan.ts"
import { imagesOf, messageOf, promptImages, promptOf } from "./prompts.ts"
import { createTasks, type Child } from "./tasks.ts"
import {
  absolute,
  blankEnd,
  called,
  executeNames,
  goesOn,
  innerCall,
  kindOf,
  questionOutcome,
  resumes,
  succeeded,
} from "./tools.ts"
import { modelKey, retryReason, type Windows } from "./usage.ts"
import type { Form, PermissionRequest } from "./wire/asks.ts"
import type { OpencodeEvent } from "./wire/events.ts"
import { userPayload, type Message } from "./wire/messages.ts"

type Events = AgentEvent[]
type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
type Assistant = Extract<Message, { type: "assistant" }>
type StoredPart = Assistant["content"][number]
type StoredTool = Extract<StoredPart, { type: "tool" }>
type StoredCompaction = Extract<Message, { type: "compaction" }>

type Outcome = "succeeded" | "failed" | "interrupted"
export type WireModel = { providerID: string; id: string; variant?: string }
// `plan`: the last file the turn wrote in the plan folder in a step a plan mode ran. `compacted`: it ran a compaction
// someone asked for, so with no step it made no model turn of its own. `notice`: why a compaction failed, told as the
// turn ends.
type Turn = {
  at: number
  input: number
  output: number
  tokens: number
  error: string | null
  plan: string | null
  stepped: boolean
  compacted: boolean
  notice: string | null
}

export const partOf = (message: string, kind: "text" | "reasoning", ordinal: number): PartId =>
  `${message}:${kind}:${ordinal}`

const DELETED = { text: "This session was deleted in opencode", detail: [] }

// How a turn ended when its end event was missed and no idle entry was stored (a rejected permission or a dismissed
// form ends it with an interrupt that stores neither): the last step's error, else the session's outcome.
function missedEnd(found: { messages: Message[]; outcome: Outcome | null }): [Outcome, string | null] {
  const last = found.messages.findLast((message) => message.type === "assistant")
  const error = last?.type === "assistant" ? last.error : undefined
  if (error) return error.type === "aborted" ? ["interrupted", null] : ["failed", error.message]
  return [found.outcome ?? "succeeded", null]
}

const stamp = (events: Events, at: number): Events => events.map((event) => ({ ...event, at }))

// The session an event belongs to; a shell's end names only the shell.
function sessionOf(event: OpencodeEvent): string | null {
  if (event.type === "form.created") return event.data.form.sessionID
  if (event.type === "shell.created") return event.data.info.metadata?.sessionID ?? null
  const data: object = event.data
  return "sessionID" in data && typeof data.sessionID === "string" ? data.sessionID : null
}

// Calls, parts and asks are told the same way for the main session and a subagent's.
const SHARED = [
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
] as const
type Shared = Extract<OpencodeEvent, { type: (typeof SHARED)[number] }>
const shared = new Set<string>(SHARED)
const isShared = (event: OpencodeEvent): event is Shared => shared.has(event.type)

const OUTCOMES: Partial<Record<OpencodeEvent["type"], Outcome>> = {
  "session.execution.succeeded": "succeeded",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
}

type Tool = {
  message: string
  name: string
  parent: ToolId | null
  input: Record<string, unknown> | null
  ended: boolean
  // An `execute` shows as the call of ours its code made, or else names the calls it made.
  inner: boolean
  names?: string
}

export type Translator = ReturnType<typeof createTranslator>

// Stored subagent sessions by the call that started each, oldest message first, for a read back.
export type Children = Map<ToolId, Message[]>

// `lasting: false`: asks offer no always (see AskFrom).
export function createTranslator(options: { lasting?: boolean } = {}) {
  // Our own prompts by message id, from before they go out; their reply tells them.
  const own = new Map<string, PromptId>()
  // A command of ours that went out: opencode gives its message an id of its own, so the next user message it enqueues
  // is taken to be it.
  let command: Prompt | null = null
  // User messages told, and those opencode took in.
  const users = new Set<string>()
  const delivered = new Set<string>()
  // Prompts dropped from opencode's inbox before it took them in, by another client or before their reply came.
  const dropped = new Set<string>()
  // Assistant messages whose step started, and those whose tokens are counted.
  const steps = new Set<string>()
  // The agent that ran each of the main session's steps, by assistant message.
  const stepAgents = new Map<string, ModeId>()
  const counted = new Set<string>()
  const parts = new Map<PartId, { message: string; parent: ToolId | null; open: boolean }>()
  const tools = new Map<ToolId, Tool>()
  // `session`: the one the ask is of, a subagent's or the main one. `note`: what YellowCode sent with its no. `form`:
  // the form a question asks, for its reply.
  const asks = new Map<AskId, { call: ToolId | null; session: string; note: string; form: Form | null }>()
  const tasks = createTasks()
  // The main session's message ids told so far, in the order they were told.
  const messages: string[] = []
  let turn: Turn | null = null
  let modes: Modes = { rows: [], planFolders: [], models: new Map() }
  let mode: ModeId | null = null
  let cost: number | null = null
  // A subagent's spend is not in the session's, so each child's last word on its own is added.
  const spent = new Map<string, number>()
  let windows: Windows = new Map()
  // The model of the last step, the input and cache it read, and the window last told.
  let model: string | null = null
  let used = 0
  let window: number | null = null
  // The compaction running, by its message ("" when opencode did not name it; its end never does), and those ended.
  let compacting: string | null = null
  const compacted = new Set<string>()
  // Unnamed compactions whose end the stream told; a resync finds them stored under a name it does not know yet.
  let unnamed = 0
  let title: string | null = null
  // What the session runs: its own pick (a switch, or what it stored), the last step's model, opencode's default and
  // the models listed without levels. `shown` and `effort` are what was last told; nothing is told before a pick or
  // the models.
  let picked: WireModel | null = null
  let stepped: WireModel | null = null
  let fallback: WireModel | null = null
  let levelless = new Set<string>()
  let shown: WireModel | null = null
  let effort: EffortId | null = null
  // The session's folder, which relative paths are in.
  let directory = ""
  // When the event or resync being read happened.
  let now = 0

  const knowMessage = (id: string) => {
    if (!messages.includes(id)) messages.push(id)
  }

  const modeKind = (id: ModeId | null) => modes.rows.find((row) => row.id === id)?.kind ?? null
  const planning = () => modeKind(mode) === "plan"

  // opencode's "default" variant is none.
  const plain = ({ providerID, id, variant }: WireModel): WireModel =>
    variant === undefined || variant === DEFAULT_VARIANT ? { providerID, id } : { providerID, id, variant }

  // Told only when it changed. No variant is the default level; a model without levels has no effort.
  function show(ref: WireModel): Events {
    const next = plain(ref)
    const level = levelless.has(modelKey(next)) ? null : (next.variant ?? DEFAULT_VARIANT)
    const same = shown?.providerID === next.providerID && shown.id === next.id
    const before = effort
    shown = next
    effort = level
    if (same && before === level) return []
    const told: Events = [{ type: "effort", effort: level, at: 0 }]
    return same ? told : [{ type: "model", model: { provider: next.providerID, id: next.id }, at: 0 }, ...told]
  }

  // Without a pick the session runs its mode's model, else opencode's default.
  const unpicked = () => (mode === null ? undefined : modes.models.get(mode)) ?? fallback

  function chosen(ref: WireModel): Events {
    picked = plain(ref)
    return show(ref)
  }

  // Without a pick, what is told follows what opencode runs, once anything was told.
  const follows = () => picked === null && shown !== null

  function selected(agent: ModeId): Events {
    mode = agent
    const told: Events = [{ type: "mode", mode: agent, at: 0 }]
    const runs = unpicked()
    return follows() && runs ? [...told, ...show(runs)] : told
  }

  // A prompt opencode took as message `message`, once. One from another client may be taken in already.
  function user(message: string, text: string, images: Image[], history: boolean): Events {
    if (users.has(message)) return []
    users.add(message)
    knowMessage(message)
    const prompt = own.get(message) ?? promptOf(message)
    const told: AgentEvent = { type: "user", prompt, text, images, to: null, history, cutPoint: true, at: 0 }
    if (history) return [told]
    if (dropped.has(message)) return [told, { type: "user.dropped", prompt, at: 0 }]
    return delivered.has(message) ? [told, { type: "user.taken", prompts: [prompt], at: 0 }] : [told]
  }

  // A prompt another client sent, as opencode enqueued or stored it. While our command waits for its message, the
  // first one not shown yet is the command's.
  function theirs(message: string, payload: unknown): Events {
    if (own.has(message)) return []
    if (command && !users.has(message)) {
      const ours = command
      command = null
      own.set(message, ours.id)
      return user(message, ours.text, promptImages(ours), false)
    }
    const parsed = userPayload.safeParse(payload)
    return parsed.success ? user(message, parsed.data.text, imagesOf(parsed.data.files), false) : []
  }

  function deleted(): Events {
    turn = null
    return [...endParts(null), { type: "ended", problem: DELETED, final: true, at: 0 }]
  }

  function openTurn(): Events {
    if (turn) return []
    turn = {
      at: now,
      input: 0,
      output: 0,
      tokens: 0,
      error: null,
      plan: null,
      stepped: false,
      compacted: false,
      notice: null,
    }
    return [{ type: "turn.open", prompts: [], endedTasks: tasks.takeEnded(), at: 0 }]
  }

  // A subagent's steps are no steps of the turn.
  function step(message: string, parent: ToolId | null): Events {
    if (steps.has(message)) return []
    steps.add(message)
    if (parent !== null) return []
    knowMessage(message)
    const opened = openTurn()
    if (turn) turn.stepped = true
    return [...opened, { type: "reply", at: 0 }, { type: "turn.step", prompts: [], at: 0 }]
  }

  // A subagent's tokens count for its task, not for the turn or the context.
  function count(message: string, tokens: Tokens, child: Child | undefined): Events {
    if (counted.has(message)) return []
    counted.add(message)
    const cache = tokens.cache.read + tokens.cache.write
    const all = tokens.input + tokens.output + tokens.reasoning + cache
    if (child) {
      child.tokens += all
      return []
    }
    if (turn) {
      turn.input += tokens.input
      turn.output += tokens.output
      turn.tokens += all
    }
    used = tokens.input + cache
    return [{ type: "context.used", tokens: used, at: 0 }]
  }

  // The main session's step runs on `ref`; its window is told when it changes.
  function stepModel(ref: WireModel): Events {
    stepped = plain(ref)
    model = modelKey(ref)
    const found = windows.get(model)
    if (found === undefined || found === window) return []
    window = found
    return [{ type: "context.window", tokens: found, at: 0 }]
  }

  // A stored compaction a resync finds running is the one the stream did not name. `asked`: one from /compact, which
  // opencode names; an automatic one it does not.
  function compactionStarted(id: string | null, asked: boolean): Events {
    if (turn && asked) turn.compacted = true
    if (compacting !== null) {
      if (compacting === "" && id !== null) compacting = id
      return []
    }
    if (id !== null && compacted.has(id)) return []
    compacting = id ?? ""
    if (id !== null) knowMessage(id)
    return [{ type: "compaction", running: true, at: 0 }]
  }

  // The context then holds the summary, which was the summary request's output. An end with no name and none running
  // was told by a resync already. A failure inside a turn is told as the turn ends, since a failed automatic
  // compaction fails the prompt's turn with the same text.
  function compactionEnded(id: string | null, tokens: Tokens | undefined, error: string | null): Events {
    const key = id ?? compacting
    if (key === null || compacted.has(key)) return []
    if (compacting === key || compacting === "") compacting = null
    if (key === "") unnamed++
    else {
      compacted.add(key)
      knowMessage(key)
    }
    if (error !== null) {
      const stopped: Events = [{ type: "compaction", running: false, at: 0 }]
      if (turn) turn.notice = error
      else stopped.push({ type: "notice", level: "warning", text: error, at: 0 })
      return stopped
    }
    const before = used > 0 ? used : null
    const after = tokens ? tokens.output : null
    if (after !== null) used = after
    return [{ type: "compacted", before, after, at: 0 }]
  }

  function storedCompaction(message: StoredCompaction, resync: boolean): Events {
    if (message.status === "running") return compactionStarted(message.id, message.reason === "manual")
    if (resync && unnamed > 0 && !compacted.has(message.id)) {
      unnamed--
      compacted.add(message.id)
      knowMessage(message.id)
      return []
    }
    if (turn && message.reason === "manual") turn.compacted = true
    const error = message.status === "failed" ? (message.error?.message ?? "The compaction failed") : null
    return compactionEnded(message.id, message.tokens, error)
  }

  // A compaction failure the turn held is told, unless the turn failed with the same text.
  function heldNotice(ended: Turn, error: string | null): Events {
    if (ended.notice === null || ended.notice === error) return []
    return [{ type: "notice", level: "warning", text: ended.notice, at: 0 }]
  }

  // The turn is over without an end of its own.
  function dropTurn(): Events {
    const held = turn ? heldNotice(turn, null) : []
    turn = null
    return held
  }

  const sessionCost = () =>
    cost === null && spent.size === 0 ? null : (cost ?? 0) + [...spent.values()].reduce((sum, one) => sum + one, 0)

  // A step stopped once its model reply was over still counts that reply's tokens.
  function stepFailed(failure: { assistantMessageID: string; tokens?: Tokens }, child: Child | undefined): Events {
    const ended = endParts(failure.assistantMessageID)
    return failure.tokens ? [...ended, ...count(failure.assistantMessageID, failure.tokens, child)] : ended
  }

  function partStart(
    part: PartId,
    kind: "text" | "reasoning",
    message: string,
    text: string,
    parent: ToolId | null,
    live = true,
  ): Events {
    if (parts.has(part)) return []
    parts.set(part, { message, parent, open: true })
    return kind === "text"
      ? [{ type: "text.start", part, parent, text, local: false, quiet: false, at: 0 }]
      : [{ type: "thinking.start", part, parent, text, live, at: 0 }]
  }

  function partEnd(part: PartId, kind: "text" | "reasoning", text: string | null): Events {
    const known = parts.get(part)
    if (!known?.open) return []
    known.open = false
    return [{ type: kind === "text" ? "text.end" : "thinking.end", part, text, at: 0 }]
  }

  function partDelta(part: PartId, kind: "text" | "reasoning", text: string): Events {
    if (!parts.get(part)?.open) return []
    return [{ type: kind === "text" ? "text.delta" : "thinking.delta", part, text, at: 0 }]
  }

  // Parts that stopped short end with what they streamed: one message's, one subagent's, or (null) all.
  function endParts(message: string | null, parent?: ToolId): Events {
    const events: Events = []
    for (const [part, known] of parts) {
      if (!known.open || (message !== null && known.message !== message)) continue
      if (parent !== undefined && known.parent !== parent) continue
      known.open = false
      events.push({ type: part.includes(":reasoning:") ? "thinking.end" : "text.end", part, text: null, at: 0 })
    }
    return events
  }

  function toolStart(id: ToolId, name: string, message: string, parent: ToolId | null): Events {
    if (tools.has(id)) return []
    tools.set(id, { message, name, parent, input: null, ended: false, inner: false })
    const kind = kindOf(name)
    return [{ type: "tool.start", id, parent, name, kind, title: name, mcp: null, quiet: false, at: 0 }]
  }

  function toolCalled(
    id: ToolId,
    input: Record<string, unknown>,
    child: Child | undefined,
    background = false,
  ): Events {
    const known = tools.get(id)
    if (!known || known.input !== null) return []
    known.input = input
    const event = called(id, known.name, input, directory, background)
    const activity = event.summary.startsWith(`${directory}/`)
      ? event.summary.slice(directory.length + 1)
      : event.summary
    return [event, ...(child ? tasks.acted(child, known.name, activity, now) : [])]
  }

  function inner(id: ToolId, metadata: unknown): Events {
    const known = tools.get(id)
    if (known?.name !== "execute" || !known.input || known.inner || known.ended) return []
    const call = innerCall(id, metadata)
    if (call) {
      known.inner = true
      return [call]
    }
    const names = executeNames(metadata)
    if (!names || names === known.names) return []
    known.names = names
    return [{ ...called(id, known.name, known.input, directory, false), summary: names }]
  }

  // A shell's or a subagent's call names what it runs, and an `execute` the calls its code makes.
  function progress(id: ToolId, metadata: unknown, child: Child | undefined): Events {
    const known = tools.get(id)
    if (known?.name === "execute") return inner(id, metadata)
    const kind = known && kindOf(known.name)
    if (!known?.input || (kind !== "shell" && kind !== "agent")) return []
    const call = {
      id,
      input: known.input,
      background: known.input["background"] === true,
      resumed: resumes(known.input),
    }
    return tasks.linked(call, metadata, child?.id ?? null, now)
  }

  function toolDone(id: ToolId, end: AgentEvent): Events {
    const known = tools.get(id)
    if (!known || known.ended) return []
    known.ended = true
    return [end]
  }

  function toolSucceeded(id: ToolId, content: { type: string; text?: string }[], metadata: unknown): Events {
    const known = tools.get(id)
    if (!known || known.ended) return []
    const path = known.input?.["path"]
    const writes = kindOf(known.name) === "write" || kindOf(known.name) === "edit"
    // A switch during the turn applies from the next step, so the step's own agent decides.
    const planned = modeKind(stepAgents.get(known.message) ?? mode) === "plan"
    if (turn && known.parent === null && writes && planned && typeof path === "string") {
      // opencode's `*` takes `..` too, so the path is matched as it resolves.
      const file = normalize(absolute(path, directory))
      if (inPlanFolder(modes.planFolders, file)) turn.plan = file
    }
    const end = succeeded({ id, name: known.name, input: known.input ?? {} }, content, metadata, directory)
    if (end.background && end.task) return [...tasks.moved(end.task), ...toolDone(id, end)]
    const state = end.exitCode === null || end.exitCode === 0 ? "completed" : "failed"
    return [...inner(id, metadata), ...tasks.settled(id, state, now, turn !== null), ...toolDone(id, end)]
  }

  // A rejected permission carries what the user said; a subagent the user stopped counts as stopped.
  function failed(id: ToolId, error: { type: string; message: string }): Events {
    if (tools.get(id)?.ended !== false) return []
    const task = tasks.ofCall(id)
    const stopped = error.type === "aborted" || (task !== null && tasks.stopped(task))
    const end = { ...blankEnd(id, stopped ? "stopped" : "error", error.message), task }
    if (error.type === "permission.rejected")
      end.outcome = { status: "denied", said: error.message, why: "declined", note: error.message }
    return [...tasks.settled(id, stopped ? "stopped" : "failed", now, turn !== null), ...toolDone(id, end)]
  }

  // A turn that went well, wrote a plan file in plan mode and is still in it ends with the plan; it goes on in build.
  // Its text is read by the agent.
  function endTurn(kind: Outcome, error: string | null, at: number): Events {
    if (!turn) return []
    const ended = turn
    turn = null
    const next = modes.rows.find((row) => row.kind === "auto")?.id ?? null
    const plan: Events =
      kind === "succeeded" && ended.plan !== null && planning()
        ? [{ type: "plan", text: null, path: ended.plan, next, at: 0 }]
        : []
    const failure = kind === "failed" ? (error ?? ended.error ?? "The turn failed") : null
    return [
      ...endParts(null),
      ...heldNotice(ended, failure),
      {
        type: "turn.end",
        error: failure,
        interrupted: kind === "interrupted",
        local: ended.compacted && !ended.stepped,
        durationMs: Math.max(0, at - ended.at),
        inputTokens: ended.input,
        outputTokens: ended.output,
        tokens: ended.tokens,
        sessionCostUsd: sessionCost(),
        prompts: [],
        at: 0,
      },
      ...plan,
    ]
  }

  function askOpen(id: AskId, session: string, ask: () => AgentEvent, asked: Form | null = null): Events {
    if (asks.has(id)) return []
    const event = ask()
    const call = event.type === "ask.open" ? event.ask.call : null
    asks.set(id, { call, session, note: "", form: asked })
    return [event]
  }

  function askClose(id: AskId, event: AgentEvent): Events {
    if (!asks.has(id)) return []
    asks.delete(id)
    return [event]
  }

  function permission(request: PermissionRequest): Events {
    const call = request.source?.id ?? null
    const from = {
      call,
      tool: (call && tools.get(call)?.name) ?? null,
      by: tasks.child(request.sessionID)?.id ?? null,
      directory,
      lasting: options.lasting ?? true,
    }
    return askOpen(request.id, request.sessionID, () => ({
      type: "ask.open",
      ask: permissionAsk(request, from),
      at: 0,
    }))
  }

  function form(info: Form): Events {
    return askOpen(info.id, info.sessionID, () => ({ type: "ask.open", ask: formAsk(info), at: 0 }), info)
  }

  // What a subagent's session says, under its call. Its turns are the task's.
  function inChild(event: OpencodeEvent, child: Child, at: number): Events {
    const parent = child.call
    if (event.type === "session.step.started") {
      step(event.data.assistantMessageID, parent)
      return tasks.model(child, event.data.model.id)
    }
    if (event.type === "session.step.ended") return count(event.data.assistantMessageID, event.data.tokens, child)
    if (event.type === "session.step.failed") return stepFailed(event.data, child)
    if (event.type === "session.usage.updated") {
      spent.set(child.id, event.data.cost)
      return []
    }
    const outcome = OUTCOMES[event.type]
    if (outcome) return [...endParts(null, parent), ...tasks.childEnded(child, outcome, at, turn !== null)]
    if (event.type === "session.text.ended") child.said = event.data.text
    return isShared(event) ? mainOrChild(event, parent, child) : []
  }

  // What the main session and a subagent's tell the same way, `parent` naming the subagent's call.
  function mainOrChild(event: Shared, parent: ToolId | null, child: Child | undefined): Events {
    switch (event.type) {
      case "session.text.started":
      case "session.reasoning.started": {
        const kind = event.type === "session.text.started" ? "text" : "reasoning"
        const message = event.data.assistantMessageID
        const part = partOf(message, kind, event.data.ordinal)
        return [...step(message, parent), ...partStart(part, kind, message, "", parent)]
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const kind = event.type === "session.text.delta" ? "text" : "reasoning"
        return partDelta(partOf(event.data.assistantMessageID, kind, event.data.ordinal), kind, event.data.delta)
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const kind = event.type === "session.text.ended" ? "text" : "reasoning"
        const message = event.data.assistantMessageID
        const part = partOf(message, kind, event.data.ordinal)
        return [...partStart(part, kind, message, "", parent), ...partEnd(part, kind, event.data.text)]
      }
      case "session.tool.input.started": {
        const message = event.data.assistantMessageID
        return [...step(message, parent), ...toolStart(event.data.id, event.data.name, message, parent)]
      }
      case "session.tool.input.delta":
        return tools.get(event.data.id)?.input === null
          ? [{ type: "tool.input.delta", id: event.data.id, text: event.data.delta, at: 0 }]
          : []
      case "session.tool.called":
        return toolCalled(event.data.id, event.data.input, child)
      case "session.tool.progress":
        return progress(event.data.id, event.data.metadata, child)
      case "session.tool.success":
        return toolSucceeded(event.data.id, event.data.content, event.data.metadata)
      case "session.tool.failed":
        return failed(event.data.id, event.data.error)
      case "permission.asked":
        return permission(event.data)
      case "permission.replied": {
        const id = event.data.requestID
        const note = asks.get(id)?.note
        return askClose(id, { type: "ask.close", id, outcome: permissionOutcome(event.data.reply, note), at: 0 })
      }
      case "form.created":
        return form(event.data.form)
      case "form.replied":
        return askClose(event.data.id, {
          type: "ask.close",
          id: event.data.id,
          outcome: { status: "answered", answers: formAnswers(event.data.answer), notes: {} },
          at: 0,
        })
      case "form.cancelled":
        return askClose(event.data.id, {
          type: "ask.close",
          id: event.data.id,
          outcome: { status: "cancelled" },
          at: 0,
        })
    }
    return []
  }

  function translate(event: OpencodeEvent, at: number): Events {
    now = at
    const child = tasks.child(sessionOf(event))
    if (child) return inChild(event, child, at)
    switch (event.type) {
      case "session.renamed":
        if (event.data.title === title) return []
        title = event.data.title
        return [{ type: "title", title: event.data.title, at: 0 }]
      case "session.inbox.enqueued":
        return event.data.item.type === "user" ? theirs(event.data.inboxID, event.data.item.payload) : []
      case "session.inbox.delivered": {
        const message = event.data.inboxID
        if (delivered.has(message)) return []
        delivered.add(message)
        return users.has(message)
          ? [{ type: "user.taken", prompts: [own.get(message) ?? promptOf(message)], at: 0 }]
          : []
      }
      case "session.inbox.cancelled": {
        const message = event.data.inboxID
        if (delivered.has(message) || dropped.has(message)) return []
        dropped.add(message)
        return users.has(message)
          ? [{ type: "user.dropped", prompt: own.get(message) ?? promptOf(message), at: 0 }]
          : []
      }
      case "session.deleted":
        return deleted()
      case "session.agent.selected":
        return selected(event.data.agent)
      case "session.model.selected":
        return chosen(event.data.model)
      case "session.retry.scheduled": {
        const { error } = event.data
        return [
          {
            type: "retry",
            attempt: event.data.attempt - 1,
            max: null,
            delayMs: Math.max(0, event.data.at - at),
            status: error.status ?? null,
            reason: retryReason(error.type, error.status ?? null),
            at: 0,
          },
        ]
      }
      case "session.execution.started":
        return openTurn()
      case "session.compaction.started":
        return compactionStarted(event.data.inputID ?? null, event.data.reason === "manual")
      case "session.compaction.ended":
        return compactionEnded(event.data.inputID ?? null, event.data.tokens, null)
      case "session.compaction.failed":
        return compactionEnded(event.data.inputID ?? null, undefined, event.data.error.message)
      case "session.step.started": {
        const { agent } = event.data
        stepAgents.set(event.data.assistantMessageID, agent)
        // A step of another agent (a compaction's) says nothing of what the mode runs.
        const ran = follows() && (mode === null || agent === mode)
        return [
          ...step(event.data.assistantMessageID, null),
          ...stepModel(event.data.model),
          ...(ran ? show(event.data.model) : []),
        ]
      }
      case "session.step.ended":
        return count(event.data.assistantMessageID, event.data.tokens, undefined)
      case "session.step.failed":
        if (turn) turn.error = event.data.error.message
        return stepFailed(event.data, undefined)
      case "session.usage.updated":
        cost = event.data.cost
        return []
      case "session.execution.succeeded":
        return endTurn("succeeded", null, at)
      case "session.execution.failed":
        return endTurn("failed", event.data.error.message, at)
      case "session.execution.interrupted":
        return endTurn("interrupted", null, at)
      case "shell.created":
        tasks.shellCreated(event.data.info.id, sessionOf(event) ?? "", event.data.info.command)
        return []
      case "shell.exited":
        return shellEnded(event.data.id, event.data.exit, event.data.status)
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended":
      case "session.tool.input.started":
      case "session.tool.input.delta":
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed":
      case "permission.asked":
      case "permission.replied":
      case "form.created":
      case "form.replied":
      case "form.cancelled":
        return mainOrChild(event, null, undefined)
      // Told by the connection, by later stages, or nothing to tell.
      case "server.connected":
      case "worktree.resolved":
      case "project.updated":
      case "vcs.branch.updated":
      case "config.updated":
      case "integration.updated":
      case "provider.updated":
      case "model.updated":
      case "agent.updated":
      case "command.updated":
      case "skill.updated":
      case "websearch.updated":
      case "reference.updated":
      case "plugin.updated":
      case "mcp.status.changed":
      case "session.created":
      case "session.forked":
      case "session.instructions.updated":
      case "session.step.streamed":
      case "session.compaction.delta":
      case "session.tool.input.ended":
      case "shell.deleted":
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed":
        break
    }
    return []
  }

  function shellEnded(id: string, exit: number | undefined, status: string): Events {
    return tasks.shellExited(id, exit, status, turn !== null)
  }

  // A stored tool part, as far as it got. A subagent's stored session, when given, is told under its call.
  function storedTool(
    part: StoredTool,
    message: string,
    parent: ToolId | null,
    live: boolean,
    children?: Children,
  ): Events {
    const events = toolStart(part.id, part.name, message, parent)
    const state = part.state
    if (state.status === "streaming") return events
    // A stored call keeps no sign of Ctrl+B in its input, only in its end.
    const moved = state.status === "completed" && goesOn(part.name, state.metadata)
    events.push(...toolCalled(part.id, state.input, undefined, moved))
    // A resync may find a subagent running whose start the stream missed. A shell's start needs its `shell.created`.
    if (live && state.status === "running") events.push(...progress(part.id, state.metadata, undefined))
    const child = children?.get(part.id) ?? []
    for (const stored of child)
      if (stored.type === "assistant") events.push(...storedMessage(stored, true, false, part.id, children))
    if (state.status === "completed") events.push(...toolSucceeded(part.id, state.content, state.metadata))
    // A subagent whose session was interrupted was stopped, not failed.
    const idle = child.findLast((stored) => stored.type === "idle")
    const stopped = idle?.type === "idle" && idle.outcome === "interrupted"
    if (state.status === "error")
      events.push(...failed(part.id, stopped ? { ...state.error, type: "aborted" } : state.error))
    return events
  }

  // A stored assistant message: what of it was not told yet. `done`: it streams no more. `live`: it is told as part of
  // the running session, not read back for the history.
  function storedMessage(
    message: Assistant,
    done: boolean,
    live = true,
    parent: ToolId | null = null,
    children?: Children,
  ): Events {
    if (parent === null) stepAgents.set(message.id, message.agent)
    const events = step(message.id, parent)
    if (parent === null) events.push(...stepModel(message.model))
    const ordinals = { text: 0, reasoning: 0 }
    message.content.forEach((part, index) => {
      if (part.type === "tool") {
        events.push(...storedTool(part, message.id, parent, live, children))
        return
      }
      if (part.type !== "text" && part.type !== "reasoning") return
      const id = partOf(message.id, part.type, ordinals[part.type]++)
      const finished = done || index < message.content.length - 1
      events.push(...partStart(id, part.type, message.id, part.text, parent, live))
      if (finished) events.push(...partEnd(id, part.type, part.text))
    })
    if (parent === null && message.tokens && message.finish !== undefined)
      events.push(...count(message.id, message.tokens, undefined))
    return events
  }

  // Stored messages, oldest first, as the chat shows a session's past: each prompt as one from history and every step
  // done. Only a turn that did not go well ends with a row. Other entries are told by the stages that read them.
  function readBack(found: Message[], children?: Children): Events {
    const events: Events = []
    // A prompt whose turn stopped before its first step still ends with a row.
    let asked = false
    for (const message of found) {
      if (message.type === "unknown") continue
      now = message.time.created
      const told: Events = []
      if (message.type === "user") {
        told.push(...dropTurn(), ...user(message.id, message.text, imagesOf(message.files), true))
      } else if (message.type === "assistant") told.push(...storedMessage(message, true, false, null, children))
      // An automatic compaction runs in the turn of the prompt before it.
      else if (message.type === "compaction")
        told.push(...(asked ? openTurn() : []), ...storedCompaction(message, false))
      else if (message.type === "idle") {
        if (message.outcome === "succeeded") told.push(...dropTurn())
        else told.push(...(asked ? openTurn() : []), ...endTurn(message.outcome, message.error?.message ?? null, now))
      }
      if (message.type === "user") asked = true
      else if (message.type === "assistant" || message.type === "idle") asked = false
      events.push(...stamp(told, now))
    }
    events.push(...stamp(dropTurn(), now))
    return events
  }

  return {
    // Neutral events for one of this session's events.
    event: (event: OpencodeEvent, at: number) => stamp(translate(event, at), at),
    // The event is of session `session`, of one of its subagents, or of a shell either runs.
    belongs(event: OpencodeEvent, session: string): boolean {
      if (event.type === "shell.exited" || event.type === "shell.deleted") {
        const of = tasks.shellSession(event.data.id)
        return of !== null && (of === session || tasks.child(of) !== undefined)
      }
      const of = sessionOf(event)
      return of === session || tasks.child(of) !== undefined
    },
    // Relative paths in calls are in this folder.
    within(folder: string): void {
      directory = folder
    },
    // The context windows of opencode's models.
    windows(found: Windows): void {
      windows = found
    },
    // The model of the last step and what it read; null before the first.
    context: () => (model === null ? null : { model, used, window: windows.get(model) ?? 0 }),
    // The modes opencode listed, and the one the session is in.
    modes(listed: Modes, current: ModeId | null, at: number): Events {
      modes = listed
      const told: Events = [{ type: "lists", lists: { modes: listed.rows }, at }]
      return current === null ? told : [...told, ...stamp(selected(current), at)]
    },
    listed: (id: ModeId) => modes.rows.some((row) => row.id === id),
    // The model the session runs: as last told, else its mode's or the default, else the last step's.
    model: (): WireModel | null => shown ?? unpicked() ?? stepped,
    // The session picked `ref`; told if it changed.
    chosen: (ref: WireModel, at: number) => stamp(chosen(ref), at),
    // The models opencode listed and its default: the model the session runs is told.
    listedModels(groups: ModelGroup[], found: WireModel | null, at: number): Events {
      const rows = groups.flatMap((group) => group.models)
      levelless = new Set(
        rows.flatMap(({ ref, efforts }) =>
          efforts.length === 0 && ref.provider ? [modelKey({ providerID: ref.provider, id: ref.id })] : [],
        ),
      )
      fallback = found
      const runs = picked ?? unpicked() ?? stepped
      return runs ? stamp(show(runs), at) : []
    },
    isShell: (id: TaskId) => tasks.isShell(id),
    // A background shell whose output can be read once it ended.
    readable: (id: TaskId) => tasks.isShell(id) && tasks.background(id),
    has: (id: TaskId) => tasks.has(id),
    // `session` is a subagent's this session started.
    child: (session: string) => tasks.child(session) !== undefined,
    // Background shells whose end was not told yet, which a resync asks opencode about.
    runningShells: () => tasks.runningShells(),
    // What a resync found of such a shell: it ended (`gone`: opencode no longer knows it).
    shellFound(id: string, found: { exit?: number; status: string } | "gone", at: number): Events {
      return stamp(
        found === "gone" ? shellEnded(id, undefined, "killed") : shellEnded(id, found.exit, found.status),
        at,
      )
    },
    // The user asks to stop a task; `refused`: the ask did not go through.
    stopping: (id: TaskId, at: number) => stamp(tasks.stopping(id), at),
    refused: (id: TaskId) => tasks.refused(id),
    // An open ask, for its reply.
    askOf(id: AskId): { session: string; form: Form | null } | null {
      const known = asks.get(id)
      return known ? { session: known.session, form: known.form } : null
    },
    // YellowCode answers the ask with `note`; "" once the answer did not go through.
    answering(id: AskId, note: string): void {
      const known = asks.get(id)
      if (known) known.note = note
    },
    // Our prompt goes out now; what opencode says of its message before the reply is ours.
    sending(prompt: PromptId): void {
      own.set(messageOf(prompt), prompt)
    },
    // It did not go out, or its reply was lost: a stored copy is told like another client's.
    unsent(prompt: PromptId): void {
      own.delete(messageOf(prompt))
      if (command?.id === prompt) command = null
    },
    // Our command goes out now; it shows as typed.
    commanding(prompt: Prompt): void {
      command = prompt
    },
    // The message of our prompt, the id we gave unless opencode chose another.
    messageFor(prompt: PromptId): string {
      for (const [message, known] of own) if (known === prompt) return message
      return messageOf(prompt)
    },
    // opencode took our prompt as message `message`, the id we gave unless it chose another.
    sent(prompt: Prompt, message: string, at: number): Events {
      own.set(message, prompt.id)
      return stamp(user(message, prompt.text, promptImages(prompt), false), at)
    },
    // The oldest message a resync must read again: the first with a part or tool still open, else the newest told.
    // A subagent's are in its own session.
    boundary(): string | null {
      const open = new Set<string>()
      for (const known of parts.values()) if (known.open && known.parent === null) open.add(known.message)
      for (const known of tools.values()) if (!known.ended && known.parent === null) open.add(known.message)
      return messages.find((id) => open.has(id)) ?? messages.at(-1) ?? null
    },
    knows: (message: string) => messages.includes(message),
    // The session's title as last told.
    title: () => title,
    // A cut deleted this message and what came after it, so a resync no longer reads from them. The ones it knew.
    forget(message: string): string[] {
      const at = messages.indexOf(message)
      return at < 0 ? [] : messages.splice(at)
    },
    // What a resync found, oldest message first. `running`: the session runs a turn now.
    resynced(found: {
      title: string | null
      // The session's agent now, when it has one of its own; its model, when one was picked.
      agent?: string
      model?: WireModel
      cost: number
      messages: Message[]
      running: boolean
      outcome: Outcome | null
      permissions: PermissionRequest[]
      forms: Form[]
      at: number
    }): Events {
      now = found.at
      const events: Events = []
      if (found.title !== null && found.title !== title) {
        title = found.title
        events.push({ type: "title", title: found.title, at: 0 })
      }
      cost = found.cost
      if (found.agent !== undefined && found.agent !== mode) events.push(...selected(found.agent))
      if (found.model !== undefined) events.push(...chosen(found.model))
      const stored = new Map<ToolId, StoredTool>()
      const lastStep = found.messages.findLastIndex((message) => message.type === "assistant")
      const last = found.messages[lastStep]
      // Only an idle entry after the last step ends the turn.
      const idle = found.messages.slice(lastStep + 1).findLast((message) => message.type === "idle") ?? null
      // opencode drops the session from its active list a moment before the last step's end is stored and sent, so a
      // turn whose last step has not ended stays open; the stream ends it. A turn the connection left (`gone`) does not.
      const closing =
        idle === null &&
        last?.type === "assistant" &&
        last.finish === undefined &&
        last.error === undefined &&
        (turn !== null || !steps.has(last.id))
      const running = found.running || closing
      for (const message of found.messages) {
        if (message.type === "user") {
          // A stored prompt was taken in already; one told while it waited was taken while the stream was down.
          const waited = users.has(message.id) && !delivered.has(message.id)
          delivered.add(message.id)
          events.push(...theirs(message.id, message))
          if (waited) events.push({ type: "user.taken", prompts: [own.get(message.id) ?? promptOf(message.id)], at: 0 })
        }
        if (message.type === "compaction") events.push(...storedCompaction(message, true))
        if (message.type !== "assistant") continue
        for (const part of message.content) if (part.type === "tool") stored.set(part.id, part)
        const done = message.finish !== undefined || message.error !== undefined || !running
        events.push(...storedMessage(message, done))
      }
      // A subagent's asks are not in the session's lists.
      const pending = new Set([...found.permissions.map((item) => item.id), ...found.forms.map((item) => item.id)])
      for (const [id, known] of asks) {
        if (pending.has(id) || tasks.child(known.session) !== undefined) continue
        const state = known.call === null ? undefined : stored.get(known.call)?.state
        const outcome: AskOutcome = known.form
          ? state?.status === "completed"
            ? (questionOutcome(state.metadata) ?? { status: "answered", answers: {}, notes: {} })
            : { status: "cancelled" }
          : state?.status === "error" && ["permission.rejected", "aborted"].includes(state.error.type)
            ? permissionOutcome("reject", known.note)
            : state === undefined
              ? { status: "cancelled" }
              : { status: "allowed" }
        events.push(...askClose(id, { type: "ask.close", id, outcome, at: 0 }))
      }
      for (const request of found.permissions) events.push(...permission(request))
      for (const info of found.forms) events.push(...form(info))
      if (running) events.push(...openTurn())
      else if (idle) events.push(...endTurn(idle.outcome, idle.error?.message ?? null, idle.time.created))
      else events.push(...endTurn(...missedEnd(found), found.at))
      return stamp(events, found.at)
    },
    // A page of the session's past for the history, oldest first.
    readBack,
    // An earlier session goes on here: what it stored is told already, by the history.
    attached(
      found: { title: string | null; model?: WireModel; cost: number; messages: Message[] },
      at: number,
    ): Events {
      readBack(found.messages)
      cost = found.cost
      const told: Events = found.model ? chosen(found.model) : []
      if (found.title !== null && found.title !== title) {
        title = found.title
        told.push({ type: "title", title: found.title, at: 0 })
      }
      // The read back's own events are the history's, so what fills the context is told here.
      if (window !== null) told.push({ type: "context.window", tokens: window, at: 0 })
      if (used > 0) told.push({ type: "context.used", tokens: used, at: 0 })
      return stamp(told, at)
    },
    // The session was deleted from another client.
    deleted: (at: number) => stamp(deleted(), at),
    // The connection is gone: what was open stays as it streamed.
    gone(at: number): Events {
      turn = null
      return stamp(endParts(null), at)
    },
  }
}
