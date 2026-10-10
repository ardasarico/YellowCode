import { RGBA, TextAttributes } from "@opentui/core"
import { Index, Show } from "solid-js"
import type { SessionEntry } from "../resume/session-list.ts"
import { theme } from "../theme/theme.ts"
import { cut, formatAgo } from "./format.ts"

const MARK = "● "
const onAccent = () => theme.background ?? RGBA.fromIndex(0)

// The recent sessions under the welcome tile, at its width. The selected row takes the dialog's accent look, like
// the filled `/` list right above it.
export function RecentList(props: { entries: SessionEntry[]; selected: number | null; width: number }) {
  const rows = () => {
    const now = Date.now()
    return props.entries.map((entry, index) => {
      const ago = formatAgo(entry.modified, now)
      const mark = props.selected === index ? MARK : ""
      const room = props.width - Bun.stringWidth(mark) - Bun.stringWidth(ago)
      const title = cut(entry.title, Math.max(0, room - 2))
      const gap = " ".repeat(Math.max(1, room - Bun.stringWidth(title)))
      return { mark, title, gap, ago }
    })
  }

  return (
    <box flexDirection="column" width={props.width} flexShrink={0}>
      <text fg={theme.muted}>Recent</text>
      <Index each={rows()}>
        {(row) => (
          <Show
            when={row().mark}
            fallback={
              <text wrapMode="none">
                <span style={{ fg: theme.text }}>{row().title}</span>
                {row().gap}
                <span style={{ fg: theme.muted }}>{row().ago}</span>
              </text>
            }
          >
            <box height={1} backgroundColor={theme.accent}>
              <text wrapMode="none" fg={onAccent()} attributes={TextAttributes.BOLD}>
                {`${row().mark}${row().title}${row().gap}${row().ago}`}
              </text>
            </box>
          </Show>
        )}
      </Index>
    </box>
  )
}
