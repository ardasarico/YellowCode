// Pi's session events as YellowCode's. One pi run (agent_start to agent_settled) is one turn; each pi turn after the
// first is a step of it, and a steered or queued prompt comes in as the user message that opens such a step. Pi does
// not echo our prompt ids, so a user message is matched to the oldest prompt we sent with the same text, or else the
// oldest one (a prompt template changes the text).
import type { AgentEvent } from "../../agent/events.ts"
import type { PromptId, ToolId } from "../../agent/ids.ts"
import { calledOf, endOf, kindOf, textOf } from "./tools.ts"
import type { Message, PiEvent, Usage } from "./wire.ts"

export type Via = "start" | "steer" | "queue"

type Own = { id: PromptId; text: string; via: Via }

// Events without their time; the translator stamps them.
type Bare = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "at"> : never) : never

export type Translator = {
  sent(id: PromptId, text: string, via: Via): void
  // The prompt did not go out.
  forget(id: PromptId): void
  event(event: PiEvent, at: number): AgentEvent[]
  // Pi let these waiting prompts go (a cleared queue).
  dropped(texts: string[], at: number): AgentEvent[]
  // Pi handled a prompt itself (an extension's command) and started no run.
  handled(id: PromptId, text: string, at: number): AgentEvent[]
  running(): boolean
  // Pi went away: what runs ends.
  gone(at: number): AgentEvent[]
}

const RETRY_REASONS: [RegExp, string][] = [
  [/\b429\b|rate.?limit/i, "rate_limit"],
  [/\b529\b|overload/i, "overloaded"],
  [/\b401\b|\b403\b|auth/i, "authentication_failed"],
  [/\b5\d\d\b/, "server_error"],
]

const reasonOf = (text: string | undefined) => RETRY_REASONS.find(([pattern]) => pattern.test(text ?? ""))?.[1] ?? ""

const userText = (message: Message) => (typeof message.content === "string" ? message.content : textOf(message.content))

// Every pi line gives at least one event.
function stamp(events: Bare[], at: number): AgentEvent[] {
  const stamped: AgentEvent[] = []
  for (const event of events.length > 0 ? events : [{ type: "seen" as const }]) stamped.push({ ...event, at })
  return stamped
}

export function createTranslator(cwd: string): Translator {
  const own: Own[] = []
  let running = false
  let startedAt = 0
  let firstUser = false
  let stepping = false
  // Each assistant message numbers its parts; the number goes on across the session, so part ids never repeat.
  let message = 0
  let streamed = new Set<number>()
  const callAt = new Map<number, ToolId>()
  const tools = new Map<ToolId, { name: string; input: unknown; ended: boolean }>()
  const totals = { input: 0, output: 0, tokens: 0 }
  let last: Message | null = null

  const partId = (index: number) => `pi-${message}-${index}`

  function take(text: string): Own | null {
    const at = own.findIndex((prompt) => prompt.text === text)
    const index = at >= 0 ? at : own.length > 0 ? 0 : -1
    return index < 0 ? null : (own.splice(index, 1)[0] ?? null)
  }

  function step(prompts: PromptId[]): Bare[] {
    if (!stepping) return []
    stepping = false
    return [{ type: "turn.step", prompts }]
  }

  function user(entry: Message): Bare[] {
    const text = userText(entry)
    const prompt = take(text)
    const shown: Bare = {
      type: "user",
      prompt: prompt?.id ?? null,
      text,
      images: [],
      to: null,
      history: false,
      cutPoint: false,
    }
    if (!firstUser) {
      firstUser = true
      stepping = false
      return [shown]
    }
    const taken: Bare[] = prompt && prompt.via !== "start" ? [{ type: "user.taken", prompts: [prompt.id] }] : []
    return [shown, ...taken, ...step(prompt ? [prompt.id] : [])]
  }

  function call(id: ToolId, name: string): Bare {
    tools.set(id, { name, input: null, ended: false })
    return { type: "tool.start", id, parent: null, name, kind: kindOf(name), title: name, mcp: null, quiet: false }
  }

  function add(usage: Usage | undefined): void {
    if (!usage) return
    totals.input += usage.input + usage.cacheRead + usage.cacheWrite
    totals.output += usage.output
    totals.tokens += usage.totalTokens
  }

  // Parts of the message that did not stream come whole.
  function unstreamed(done: Message): Bare[] {
    if (typeof done.content === "string" || !done.content) return []
    return done.content.flatMap((part, index): Bare[] => {
      if (streamed.has(index)) return []
      const id = partId(index)
      if (part.type === "text" && part.text)
        return [
          { type: "text.start", part: id, parent: null, text: part.text, local: false, quiet: false },
          { type: "text.end", part: id, text: null },
        ]
      if (part.type === "thinking" && part.thinking)
        return [
          { type: "thinking.start", part: id, parent: null, text: part.thinking, live: false },
          { type: "thinking.end", part: id, text: null },
        ]
      if (part.type === "toolCall" && part.id && part.name && !tools.has(part.id)) {
        const { at: _, ...called } = calledOf(part.id, part.name, part.arguments, 0)
        tools.set(part.id, { name: part.name, input: part.arguments, ended: false })
        return [call(part.id, part.name), called]
      }
      return []
    })
  }

  function assistant(update: Extract<PiEvent, { type: "message_update" }>["assistantMessageEvent"]): Bare[] {
    const index = update.contentIndex ?? 0
    const id = partId(index)
    switch (update.type) {
      case "text_start":
        streamed.add(index)
        return [{ type: "text.start", part: id, parent: null, text: "", local: false, quiet: false }]
      case "text_delta":
        return update.delta ? [{ type: "text.delta", part: id, text: update.delta }] : []
      case "text_end":
        return [{ type: "text.end", part: id, text: update.content ?? null }]
      case "thinking_start":
        streamed.add(index)
        return [{ type: "thinking.start", part: id, parent: null, text: "", live: true }]
      case "thinking_delta":
        return update.delta ? [{ type: "thinking.delta", part: id, text: update.delta }] : []
      case "thinking_end":
        return [{ type: "thinking.end", part: id, text: update.content ?? null }]
      case "toolcall_start": {
        if (!update.id) return []
        streamed.add(index)
        callAt.set(index, update.id)
        return [call(update.id, update.toolName ?? "tool")]
      }
      case "toolcall_delta": {
        const tool = callAt.get(index)
        return tool && update.delta ? [{ type: "tool.input.delta", id: tool, text: update.delta }] : []
      }
      case "toolcall_end": {
        const done = update.toolCall
        if (!done) return []
        const known = tools.get(done.id)
        if (known) known.input = done.arguments
        const { at: _, ...called } = calledOf(done.id, done.name, done.arguments, 0)
        return [called]
      }
      default:
        return []
    }
  }

  function stopTools(): Bare[] {
    const events: Bare[] = []
    for (const [id, tool] of tools) {
      if (tool.ended) continue
      tool.ended = true
      const { at: _, ...ended } = endOf(id, tool.name, tool.input, undefined, false, cwd, 0)
      events.push({ ...ended, status: "stopped" })
    }
    return events
  }

  function settle(aborted: boolean, at: number): Bare[] {
    const stop = last?.stopReason
    const interrupted = aborted || stop === "aborted"
    const error = !interrupted && stop === "error" ? (last?.errorMessage ?? "pi stopped with an error") : null
    const waiting = own.filter((prompt) => prompt.via !== "start")
    own.splice(0, own.length, ...own.filter((prompt) => prompt.via === "start"))
    const events: Bare[] = [
      ...stopTools(),
      {
        type: "turn.end",
        error,
        interrupted,
        local: false,
        durationMs: Math.max(0, at - startedAt),
        inputTokens: totals.input,
        outputTokens: totals.output,
        tokens: totals.tokens,
        sessionCostUsd: null,
        prompts: [],
      },
      ...waiting.map((prompt): Bare => ({ type: "user.dropped", prompt: prompt.id })),
    ]
    running = false
    tools.clear()
    last = null
    return events
  }

  function translate(event: PiEvent, at: number): Bare[] {
    switch (event.type) {
      case "agent_start":
        running = true
        startedAt = at
        firstUser = false
        stepping = false
        Object.assign(totals, { input: 0, output: 0, tokens: 0 })
        return [{ type: "turn.open", prompts: [], endedTasks: [] }]
      case "turn_start":
        stepping = firstUser
        return []
      case "message_start":
        if (event.message.role === "user") return user(event.message)
        if (event.message.role !== "assistant") return []
        message += 1
        streamed = new Set()
        callAt.clear()
        return [...step([]), { type: "reply" }]
      case "message_update":
        return assistant(event.assistantMessageEvent)
      case "message_end":
        if (event.message.role !== "assistant") return []
        add(event.message.usage)
        last = event.message
        return unstreamed(event.message)
      case "tool_execution_start": {
        if (tools.has(event.toolCallId)) return []
        const { at: _, ...called } = calledOf(event.toolCallId, event.toolName, event.args, 0)
        return [call(event.toolCallId, event.toolName), called]
      }
      case "tool_execution_update": {
        const text = textOf(event.partialResult?.content)
        return text ? [{ type: "tool.output", id: event.toolCallId, text }] : []
      }
      case "tool_execution_end": {
        const tool = tools.get(event.toolCallId)
        if (tool) tool.ended = true
        const input = tool?.input ?? null
        const { at: _, ...ended } = endOf(
          event.toolCallId,
          event.toolName,
          input,
          event.result,
          event.isError === true,
          cwd,
          0,
        )
        return [ended]
      }
      case "agent_settled":
        return running ? settle(event.aborted === true, at) : []
      case "auto_retry_start":
        return [
          {
            type: "retry",
            attempt: event.attempt,
            max: event.maxAttempts ?? null,
            delayMs: event.delayMs ?? null,
            status: null,
            reason: reasonOf(event.errorMessage),
          },
        ]
      case "compaction_start":
        return [{ type: "compaction", running: true }]
      case "compaction_end":
        return [
          { type: "compaction", running: false },
          ...(event.aborted ? [] : [{ type: "compacted" as const, before: null, after: null }]),
        ]
      case "session_info_changed":
        return event.name ? [{ type: "title", title: event.name }] : []
      case "extension_error":
        return [
          { type: "notice", level: "warning", text: `A pi extension failed: ${event.error ?? "no reason given"}` },
        ]
      case "agent_end":
      case "turn_end":
      case "queue_update":
      case "auto_retry_end":
      case "thinking_level_changed":
      case "extension_ui_request":
        return []
    }
    return []
  }

  function forget(id: PromptId): void {
    const index = own.findIndex((prompt) => prompt.id === id)
    if (index >= 0) own.splice(index, 1)
  }

  return {
    sent(id, text, via) {
      own.push({ id, text, via })
    },
    forget,
    event: (event, at) => stamp(translate(event, at), at),
    dropped(texts, at) {
      const left = [...texts]
      const events: Bare[] = []
      for (const prompt of own.slice()) {
        const index = left.indexOf(prompt.text)
        if (prompt.via === "start" || index < 0) continue
        left.splice(index, 1)
        own.splice(own.indexOf(prompt), 1)
        events.push({ type: "user.dropped", prompt: prompt.id })
      }
      return stamp(events, at)
    },
    handled(id, text, at) {
      forget(id)
      return stamp(
        [
          { type: "user", prompt: id, text, images: [], to: null, history: false, cutPoint: false },
          {
            type: "turn.end",
            error: null,
            interrupted: false,
            local: true,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            tokens: 0,
            sessionCostUsd: null,
            prompts: [],
          },
        ],
        at,
      )
    },
    running: () => running,
    gone(at) {
      if (!running) return []
      last = { role: "assistant", stopReason: "error", errorMessage: "pi stopped responding" }
      return stamp(settle(false, at), at)
    },
  }
}
