import type { RGBA } from "@opentui/core"
import type { Usage, Window } from "../session/types.ts"
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
  mcpFailure: string | null
  settingsProblem: string | null
  asking: boolean
  quitArmed: boolean
  rewindArmed: boolean
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

const HINTS = "F3 sidebar · F4 ultracode"

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
  if (state.quitArmed) return [quitHint()]
  if (state.rewindArmed) return [rewindHint()]
  if (state.mcpFailure) return [{ text: `✗ ${state.mcpFailure} failed to connect`, fg: theme.error }]
  if (state.settingsProblem) return [problemNotice(state.settingsProblem)]
  const warning = warningText(state.usage, state.now)
  if (warning) return [warning]
  if (state.asking) return []
  if (state.readOnly !== null) return [{ text: `${state.readOnly} · read-only transcript`, fg: theme.muted }]
  const replay = state.replay
  if (replay === null) return []
  return [{ text: `▶ ${replay.file} · ${replay.speed} · ${STATUS_TEXT[replay.status()]}`, fg: theme.muted }]
}

export function noticeFor(state: NoticeState): Notice {
  return { left: leftSpans(state), right: state.asking ? [] : [{ text: HINTS, fg: theme.muted }] }
}
