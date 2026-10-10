import type { RGBA } from "@opentui/core"
import type { Usage, Window } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import type { ScrollState } from "./chat-view.tsx"
import { formatUntil } from "./format.ts"

export type Span = { text: string; fg: RGBA }
export type Notice = { left: Span[]; right: Span[] }

export type ReplayInfo = {
  file: string
  speed: string
  status: () => "playing" | "waiting" | "finished"
}

export type NoticeState = {
  usage: Usage
  scroll: ScrollState
  replay: ReplayInfo
  mcpFailure: string | null
  asking: boolean
  now: number
}

const STATUS_TEXT = {
  playing: "playing",
  waiting: "Enter: next message",
  finished: "finished · Ctrl+C: quit",
} as const

const HINTS = "F2 theme · F3 sidebar · F4 ultracode"

const LIMIT_NAMES: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
}

function limitWindow(usage: Usage, type: string): Window | null {
  if (type === "five_hour") return usage.limits.fiveHour
  if (type === "seven_day") return usage.limits.week
  return usage.limits.models[type.replace(/^seven_day_/, "")] ?? null
}

function warningText(usage: Usage, now: number): Span | null {
  const warning = usage.warning
  if (!warning) return null
  const name = LIMIT_NAMES[warning.type] ?? warning.type.replaceAll("_", " ")
  if (warning.status === "rejected") {
    const resets = warning.resetsAt > 0 ? ` · resets in ${formatUntil(warning.resetsAt - now)}` : ""
    return { text: `${name} limit reached${resets}`, fg: theme.error }
  }
  const window = limitWindow(usage, warning.type)
  const percent = window ? ` · ${Math.round(window.utilization * 100)}%` : ""
  return { text: `${name} limit almost reached${percent}`, fg: theme.warning }
}

function leftSpans(state: NoticeState): Span[] {
  if (state.mcpFailure) return [{ text: `✗ ${state.mcpFailure} failed to connect`, fg: theme.error }]
  const warning = warningText(state.usage, state.now)
  if (warning) return [warning]
  if (state.asking) return []
  const lines = state.scroll.newLines
  if (!state.scroll.atBottom && lines > 0) {
    return [
      { text: `↓ ${lines} new ${lines === 1 ? "line" : "lines"}`, fg: theme.accent },
      { text: " · End to jump down", fg: theme.muted },
    ]
  }
  const replay = state.replay
  return [{ text: `▶ ${replay.file} · ${replay.speed} · ${STATUS_TEXT[replay.status()]}`, fg: theme.muted }]
}

export function noticeFor(state: NoticeState): Notice {
  return { left: leftSpans(state), right: state.asking ? [] : [{ text: HINTS, fg: theme.muted }] }
}
