// An earlier pi session as events, read from its file: the branch it is on, one turn per user message. The whole
// branch is one page.
import type { AgentEvent } from "../../agent/events.ts"
import type { PromptId } from "../../agent/ids.ts"
import type { HistoryPage } from "../../agent/sessions.ts"
import { calledOf, endOf } from "./tools.ts"
import type { Entry } from "./sessions.ts"
import { branchOf } from "./sessions.ts"
import { message as messageSchema, type Message } from "./wire.ts"

type Bare = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "at"> : never) : never

const timeOf = (entry: Entry, message: Message | null) =>
  message?.timestamp ?? (typeof entry["timestamp"] === "string" ? Date.parse(entry["timestamp"]) || 0 : 0)

export function historyEvents(entries: Entry[], prompts: Map<string, PromptId>, cwd: string): AgentEvent[] {
  const events: AgentEvent[] = []
  const calls = new Map<string, { name: string; input: unknown }>()
  let open = false
  let turn: { input: number; output: number; tokens: number; error: string | null; start: number; last: number } = {
    input: 0,
    output: 0,
    tokens: 0,
    error: null,
    start: 0,
    last: 0,
  }
  const push = (at: number, ...bare: Bare[]) => {
    for (const one of bare) events.push({ ...one, at })
  }

  function close(): void {
    if (!open) return
    open = false
    push(turn.last, {
      type: "turn.end",
      error: turn.error,
      interrupted: false,
      local: false,
      durationMs: Math.max(0, turn.last - turn.start),
      inputTokens: turn.input,
      outputTokens: turn.output,
      tokens: turn.tokens,
      sessionCostUsd: null,
      prompts: [],
    })
  }

  for (const entry of branchOf(entries)) {
    if (entry.type === "session_info" && typeof entry["name"] === "string") {
      push(timeOf(entry, null), { type: "title", title: entry["name"] })
      continue
    }
    if (entry.type !== "message" || !entry.id) continue
    const parsed = messageSchema.safeParse(entry["message"])
    if (!parsed.success) continue
    const message = parsed.data
    const at = timeOf(entry, message)
    const parts =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? [])
    if (message.role === "user") {
      close()
      open = true
      turn = { input: 0, output: 0, tokens: 0, error: null, start: at, last: at }
      const text = parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n")
      push(
        at,
        { type: "turn.open", prompts: [], endedTasks: [] },
        {
          type: "user",
          prompt: prompts.get(entry.id) ?? entry.id,
          text,
          images: [],
          to: null,
          history: true,
          cutPoint: true,
        },
      )
      continue
    }
    if (!open) continue
    turn.last = at
    if (message.role === "assistant") {
      push(at, { type: "reply" })
      if (message.usage) {
        turn.input += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
        turn.output += message.usage.output
        turn.tokens += message.usage.totalTokens
      }
      if (message.stopReason === "error") turn.error = message.errorMessage ?? "pi stopped with an error"
      parts.forEach((part, index) => {
        const id = `pi-h-${entry.id}-${index}`
        if (part.type === "text" && part.text)
          push(
            at,
            { type: "text.start", part: id, parent: null, text: part.text, local: false, quiet: false },
            { type: "text.end", part: id, text: null },
          )
        else if (part.type === "thinking" && part.thinking)
          push(
            at,
            { type: "thinking.start", part: id, parent: null, text: part.thinking, live: false },
            { type: "thinking.end", part: id, text: null },
          )
        else if (part.type === "toolCall" && part.id && part.name) {
          calls.set(part.id, { name: part.name, input: part.arguments })
          const { at: _, ...called } = calledOf(part.id, part.name, part.arguments, at)
          push(
            at,
            {
              type: "tool.start",
              id: part.id,
              parent: null,
              name: part.name,
              kind: called.kind ?? "other",
              title: part.name,
              mcp: null,
              quiet: false,
            },
            called,
          )
        }
      })
      continue
    }
    if (message.role === "toolResult" && typeof entry["message"] === "object" && entry["message"] !== null) {
      const raw: Record<string, unknown> = { ...entry["message"] }
      const id = typeof raw["toolCallId"] === "string" ? raw["toolCallId"] : null
      const call = id ? calls.get(id) : undefined
      if (!id || !call) continue
      const { at: _, ...ended } = endOf(
        id,
        call.name,
        call.input,
        { content: parts, details: raw["details"] },
        raw["isError"] === true,
        cwd,
        at,
      )
      push(at, ended)
    }
  }
  close()
  return events
}

export const historyPage = (entries: Entry[], prompts: Map<string, PromptId>, cwd: string): HistoryPage => ({
  events: historyEvents(entries, prompts, cwd),
  earlier: null,
})
