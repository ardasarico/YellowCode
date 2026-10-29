import type { RGBA } from "@opentui/core"
import type { ModNotice } from "../mods/mods.ts"
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

type NoticeState = {
  usage: Usage
  replay: ReplayInfo | null
  readOnly: string | null
  status: SessionStatus
  // Enter starts Claude Code again once it has exited.
  restartable: boolean
  mcpFailure: string | null
  settingsProblem: string | null
  mod: ModNotice | null
  asking: boolean
  // Seconds the compaction has run, or null when none is going on.
  compacting: number | null
  // The first send after a rewind waits for claude to go back in the conversation.
  goingBack: boolean
  quitArmed: boolean
  rewindArmed: boolean
  // A short-lived message, such as why a command cannot run now.
  note: string | null
  // Keys are held after claude took back the ask the user was typing for.
  held: boolean
  interruptible: boolean
  // A foreground command or agent has run long enough to be worth sending to the background.
  backgroundable: boolean
  // Shift+Tab changes the permission mode only with Claude Code running.
  modes: boolean
  // F4's switch, under the agent's name for it.
  extraEffort: string | null
  // The agent reports usage limits.
  limits: boolean
  now: number
}

const STATUS_TEXT = {
  playing: "playing",
  waiting: "Enter: next message",
  finished: "finished · Ctrl+C: quit",
} as const

export const quitHint = (): Span => ({ text: "Press Ctrl+C again to quit", fg: theme.muted })
const rewindHint = (): Span => ({ text: "Press Esc again to rewind", fg: theme.muted })
export const problemNotice = (problem: string): Span => ({ text: `! ${problem}`, fg: theme.warning, bold: true })
export const modSpan = (notice: ModNotice): Span =>
  notice.problem ? problemNotice(notice.text) : { text: notice.text, fg: theme.muted }
export const startingNotice = (): Span => ({ text: "Starting Claude Code…", fg: theme.muted })

const SIDEBAR_HINT = "F3 sidebar"
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
  if (state.note) return [{ text: state.note, fg: theme.muted }]
  if (state.held) return [{ text: "Claude Code withdrew the request", fg: theme.muted }]
  const live = state.replay === null && state.readOnly === null
  if (live && state.status === "ended") {
    const restart = state.restartable ? " · Enter: restart" : ""
    return [{ text: `✗ Claude Code exited · Ctrl+C: quit${restart}`, fg: theme.error }]
  }
  if (state.mcpFailure) return [{ text: `✗ ${state.mcpFailure} failed to connect`, fg: theme.error }]
  if (state.settingsProblem) return [problemNotice(state.settingsProblem)]
  if (state.mod) return [modSpan(state.mod)]
  const warning = state.limits ? warningText(state.usage, state.now) : null
  if (warning) return [warning]
  if (state.asking) return []
  if (live && state.goingBack) return [{ text: "Going back in the conversation…", fg: theme.muted }]
  if (live && state.compacting !== null)
    return [{ text: `Compacting conversation… ${state.compacting}s`, fg: theme.muted }]
  if (state.readOnly !== null) return [{ text: `${state.readOnly} · read-only transcript`, fg: theme.muted }]
  if (live) return state.status === "starting" ? [startingNotice()] : []
  const replay = state.replay
  if (replay === null) return []
  return [{ text: `▶ ${replay.file} · ${replay.speed} · ${STATUS_TEXT[replay.status()]}`, fg: theme.muted }]
}

export function noticeFor(state: NoticeState): Notice {
  const ended = state.replay === null && state.readOnly === null && state.status === "ended"
  // With the agent gone F4 has nothing to change.
  const fkeys = state.extraEffort && !ended ? `${SIDEBAR_HINT} · F4 ${state.extraEffort}` : SIDEBAR_HINT
  const keys = !ended && state.modes ? `shift+tab mode · ${fkeys}` : fkeys
  const hints = state.backgroundable
    ? "ctrl+b runs it in the background"
    : state.interruptible
      ? `esc interrupt · ${keys}`
      : keys
  return { left: leftSpans(state), right: state.asking ? [] : [{ text: hints, fg: theme.muted }] }
}
