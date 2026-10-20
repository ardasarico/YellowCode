import type { RGBA } from "@opentui/core"
import type { SessionStatus, Usage, Window } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { formatUntil } from "./format.ts"

export type Span = { text: string; fg: RGBA; bold?: boolean }
export type Notice = { left: Span[]; right: Span[] }

export type ReplayInfo = {
  file: string
  speed: string
  status: () => "playing" | "waiting" | "finished"
}

export type NoticeState = {
  usage: Usage
  replay: ReplayInfo | null
  readOnly: string | null
  status: SessionStatus
  mcpFailure: string | null
  settingsProblem: string | null
  asking: boolean
  quitArmed: boolean
  rewindArmed: boolean
  // Keys are held after claude took back the ask the user was typing for.
  held: boolean
  interruptible: boolean
  now: number
}

const STATUS_TEXT = {
  playing: "playing",
  waiting: "Enter: next message",
  finished: "finished · Ctrl+C: quit",
} as const

export const quitHint = (): Span => ({ text: "Press Ctrl+C again to quit", fg: theme.muted })
export const rewindHint = (): Span => ({ text: "Press Esc again to rewind", fg: theme.muted })
export const problemNotice = (problem: string): Span => ({ text: `! ${problem}`, fg: theme.warning, bold: true })
export const startingNotice = (): Span => ({ text: "Starting Claude Code…", fg: theme.muted })

const HINTS = "F3 sidebar · F4 ultracode"
// With Claude Code gone F4 has nothing to change.
const ENDED_HINTS = "F3 sidebar"
const WARN_AT = 0.85

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
  const resets = warning.resetsAt > 0 ? ` · resets in ${formatUntil(warning.resetsAt - now)}` : ""
  if (warning.status === "rejected") return { text: `${name} limit reached${resets}`, fg: theme.error }
  // Claude Code warns once a usage threshold is passed, which can be far below the limit; the sidebar shows the rest.
  const window = limitWindow(usage, warning.type)
  if (!window || window.utilization < WARN_AT) return null
  return {
    text: `You've used ${Math.round(window.utilization * 100)}% of your ${name} limit${resets}`,
    fg: theme.warning,
  }
}

function leftSpans(state: NoticeState): Span[] {
  if (state.quitArmed) return [quitHint()]
  if (state.rewindArmed) return [rewindHint()]
  if (state.held) return [{ text: "Claude Code withdrew the request", fg: theme.muted }]
  const live = state.replay === null && state.readOnly === null
  if (live && state.status === "ended") return [{ text: "✗ Claude Code exited · Ctrl+C: quit", fg: theme.error }]
  if (state.mcpFailure) return [{ text: `✗ ${state.mcpFailure} failed to connect`, fg: theme.error }]
  if (state.settingsProblem) return [problemNotice(state.settingsProblem)]
  const warning = warningText(state.usage, state.now)
  if (warning) return [warning]
  if (state.asking) return []
  if (state.readOnly !== null) return [{ text: `${state.readOnly} · read-only transcript`, fg: theme.muted }]
  if (live) return state.status === "starting" ? [startingNotice()] : []
  const replay = state.replay
  if (replay === null) return []
  return [{ text: `▶ ${replay.file} · ${replay.speed} · ${STATUS_TEXT[replay.status()]}`, fg: theme.muted }]
}

export function noticeFor(state: NoticeState): Notice {
  const ended = state.replay === null && state.readOnly === null && state.status === "ended"
  const keys = ended ? ENDED_HINTS : HINTS
  const hints = state.interruptible ? `esc interrupt · ${keys}` : keys
  return { left: leftSpans(state), right: state.asking ? [] : [{ text: hints, fg: theme.muted }] }
}
