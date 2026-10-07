import { theme } from "../theme/theme.ts"

export type ReplayInfo = {
  file: string
  speed: string
  status: () => "playing" | "waiting" | "finished"
}

const STATUS_TEXT = {
  playing: "playing",
  waiting: "Enter: next message",
  finished: "finished · Ctrl+C: quit",
} as const

export function ReplayBar(props: { replay: ReplayInfo; focus: "input" | "chat" }) {
  const text = () =>
    `▶ replay: ${props.replay.file} · ${props.replay.speed} · ${STATUS_TEXT[props.replay.status()]} · Tab: ${
      props.focus === "input" ? "chat" : "input"
    }`
  return (
    <box flexShrink={0} paddingX={1}>
      <text fg={theme.muted}>{text()}</text>
    </box>
  )
}
