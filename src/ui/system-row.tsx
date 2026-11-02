import { overridable } from "../mods/overridable.tsx"
import type { RGBA } from "@opentui/core"
import { createSignal, Index, Match, Show, Switch } from "solid-js"
import type { Retry, SystemEvent } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { cut, formatTokens, wrapLines } from "./format.ts"
import { useTicker } from "./ticker.ts"

const REASONS: Record<string, string> = {
  overloaded: "overloaded",
  rate_limit: "rate limited",
  server_error: "server error",
  authentication_failed: "auth failed",
}

// A label too wide for one line wraps, each line centered between rules.
export function Divider(props: { text: string }) {
  const [width, setWidth] = createSignal(0)
  const lines = () => {
    const room = width() - 6
    const parts = room > 0 && Bun.stringWidth(props.text) > room ? wrapLines(props.text, room, Infinity) : [props.text]
    return parts.map((part) => {
      const label = ` ${part} `
      const left = Math.max(0, Math.floor((width() - Bun.stringWidth(label)) / 2))
      const right = Math.max(0, width() - Bun.stringWidth(label) - left)
      return { left: "─".repeat(left), label, right: "─".repeat(right) }
    })
  }
  return (
    <box
      flexDirection="column"
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <Index each={lines()}>
        {(line) => (
          <text wrapMode="none">
            <span style={{ fg: theme.frame }}>{line().left}</span>
            <span style={{ fg: theme.muted }}>{line().label}</span>
            <span style={{ fg: theme.frame }}>{line().right}</span>
          </text>
        )}
      </Index>
    </box>
  )
}

const sizes = (tokens: SystemEvent["tokens"]) =>
  tokens
    ? ` · ${formatTokens(tokens.before)}${tokens.after === undefined ? "" : ` → ${formatTokens(tokens.after)}`}`
    : ""

const secondsLeft = (retry: Retry) => Math.max(0, Math.ceil((retry.at + retry.delayMs - Date.now()) / 1000))

function RetryRow(props: { retry: Retry }) {
  const tick = useTicker(() => secondsLeft(props.retry) > 0, 1000)
  const text = () => {
    tick()
    const { reason, status, attempt, max } = props.retry
    const cause = `${REASONS[reason] ?? "unknown"}${status === null ? "" : ` (${status})`}`
    return `! ${cause} · retrying in ${secondsLeft(props.retry)}s · attempt ${attempt}${max === null ? "" : `/${max}`}`
  }
  return <text fg={theme.warning}>{text()}</text>
}

// Wrapped lines start under the text, not under the glyph.
function GlyphRow(props: { glyph: string; text: string; fg: RGBA }) {
  return (
    <box flexDirection="row">
      <text fg={props.fg} flexShrink={0}>{`${props.glyph} `}</text>
      <text fg={props.fg} wrapMode="word">
        {props.text}
      </text>
    </box>
  )
}

const DETAIL_INDENT = "  "

function ErrorRow(props: { text: string; detail: string[] }) {
  const [width, setWidth] = createSignal(0)
  return (
    <box
      flexDirection="column"
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <GlyphRow glyph="✗" text={props.text} fg={theme.error} />
      <Index each={props.detail}>
        {(line) => (
          <text wrapMode="none" fg={theme.muted}>
            {DETAIL_INDENT + cut(line(), width() - DETAIL_INDENT.length)}
          </text>
        )}
      </Index>
    </box>
  )
}

// An info event marks a turning point in the session, so it spans the width; a warning or an error is a glyph row.
export type SystemRowProps = { item: SystemEvent }

function SystemRowBase(props: SystemRowProps) {
  return (
    <Switch
      fallback={
        <Show when={props.item.retry} fallback={<GlyphRow glyph="!" text={props.item.text} fg={theme.warning} />}>
          {(retry) => <RetryRow retry={retry()} />}
        </Show>
      }
    >
      <Match when={props.item.level === "info"}>
        <Divider text={`${props.item.text}${sizes(props.item.tokens)}`} />
      </Match>
      <Match when={props.item.level === "error"}>
        <ErrorRow text={props.item.text} detail={props.item.detail ?? []} />
      </Match>
    </Switch>
  )
}

export const SystemRow = overridable("system-row", SystemRowBase)
