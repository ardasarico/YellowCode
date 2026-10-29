// Codex's token counts and account limits as the chat's usage events. Codex reports no cost.
import type { ContextReport } from "../../agent/agent.ts"
import type { AgentEvent, LimitWindow } from "../../agent/events.ts"
import type { RateLimits, TokenUsage } from "./wire/thread.ts"

type Events = AgentEvent[]
export type TurnTokens = { inputTokens: number; outputTokens: number; tokens: number }

// The main thread's context and the tokens of the turn that runs.
export function createMeter() {
  let used = 0
  let window = 0
  // The thread's total as last told, null until Codex tells one.
  let total: TokenUsage["total"] | null = null
  let turn: TurnTokens = { inputTokens: 0, outputTokens: 0, tokens: 0 }

  return {
    used: () => used,
    window: () => window,
    // An update during a turn adds what the thread's total grew by; the first one Codex tells is the request it made.
    update(usage: TokenUsage, inTurn: boolean): Events {
      const grown = total === null ? usage.last : usage.total
      if (inTurn) {
        turn.inputTokens += Math.max(0, grown.inputTokens - (total?.inputTokens ?? 0))
        turn.outputTokens += Math.max(0, grown.outputTokens - (total?.outputTokens ?? 0))
        turn.tokens += Math.max(0, grown.totalTokens - (total?.totalTokens ?? 0))
      }
      total = usage.total
      const events: Events = []
      const size = usage.modelContextWindow ?? window
      if (size !== window) events.push({ type: "context.window", tokens: size, at: 0 })
      window = size
      if (usage.last.totalTokens !== used) events.push({ type: "context.used", tokens: usage.last.totalTokens, at: 0 })
      used = usage.last.totalTokens
      return events
    },
    turnEnd(): TurnTokens {
      const ended = turn
      turn = { inputTokens: 0, outputTokens: 0, tokens: 0 }
      return ended
    },
  }
}

export type Meter = ReturnType<typeof createMeter>

// Codex has no categories, only the total.
export const contextReport = (model: string, used: number, window: number): ContextReport => ({
  model,
  used,
  window,
  categories: [],
  files: [],
  tools: [],
})

// The account's own limit; another names the model it is for.
const ACCOUNT_LIMIT = "codex"

// The chat's names for the windows it knows, which its limit notice reads.
const WINDOW_NAMES: Record<number, string> = { 300: "five_hour", 10080: "seven_day" }

// Windows Codex did not send this time are left as they were; a limit with none and nothing reached tells nothing.
export function limitsOf(limits: RateLimits): AgentEvent | null {
  const model = limits.limitId && limits.limitId !== ACCOUNT_LIMIT ? (limits.limitName ?? limits.limitId) : null
  const windows: LimitWindow[] = []
  for (const window of [limits.primary, limits.secondary]) {
    if (!window?.windowDurationMins || window.resetsAt === null || window.resetsAt === undefined) continue
    windows.push({
      minutes: window.windowDurationMins,
      model,
      utilization: window.usedPercent / 100,
      resetsAt: window.resetsAt * 1000,
    })
  }
  const reached = limits.rateLimitReachedType
  if (windows.length === 0 && !reached) return null
  const full = windows.find((window) => window.utilization >= 1) ?? null
  const warning = reached
    ? {
        reached: true,
        minutes: full?.minutes ?? null,
        model,
        resetsAt: full?.resetsAt ?? null,
        status: "rejected",
        type: (full && WINDOW_NAMES[full.minutes]) ?? reached,
      }
    : null
  return { type: "limits", windows, warning, at: 0 }
}
