import { createSignal, Show } from "solid-js"
import type { Retry, SystemEvent } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { useTicker } from "./ticker.ts"

const REASONS: Record<string, string> = {
  overloaded: "overloaded",
  rate_limit: "rate limited",
  server_error: "server error",
  authentication_failed: "auth failed",
}

export function Divider(props: { text: string }) {
  const [width, setWidth] = createSignal(0)
  const line = () => {
    const label = ` ${props.text} `
    const left = Math.max(0, Math.floor((width() - label.length) / 2))
    const right = Math.max(0, width() - label.length - left)
    return { left: "─".repeat(left), label, right: "─".repeat(right) }
  }
  return (
    <box
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <text wrapMode="none">
        <span style={{ fg: theme.frame }}>{line().left}</span>
        <span style={{ fg: theme.muted }}>{line().label}</span>
        <span style={{ fg: theme.frame }}>{line().right}</span>
      </text>
    </box>
  )
}

const secondsLeft = (retry: Retry) => Math.max(0, Math.ceil((retry.at + retry.delayMs - Date.now()) / 1000))

function RetryRow(props: { retry: Retry }) {
  const tick = useTicker(() => secondsLeft(props.retry) > 0, 1000)
  const text = () => {
    tick()
    const { reason, status, attempt, max } = props.retry
    const cause = `${REASONS[reason] ?? "unknown"}${status === null ? "" : ` (${status})`}`
    return `! ${cause} · retrying in ${secondsLeft(props.retry)}s · attempt ${attempt}/${max}`
  }
  return <text fg={theme.warning}>{text()}</text>
}

// An info event marks a turning point in the session, so it spans the width; a warning is a single line.
export function SystemRow(props: { item: SystemEvent }) {
  return (
    <Show
      when={props.item.level === "info"}
      fallback={
        <Show when={props.item.retry} fallback={<text fg={theme.warning}>{`! ${props.item.text}`}</text>}>
          {(retry) => <RetryRow retry={retry()} />}
        </Show>
      }
    >
      <Divider text={props.item.text} />
    </Show>
  )
}
