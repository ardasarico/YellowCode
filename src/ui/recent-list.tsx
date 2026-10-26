import { Index, Show } from "solid-js"
import { NO_PROMPT, type SessionEntry } from "../resume/session-list.ts"
import { theme } from "../theme/theme.ts"
import { cut, formatAgo } from "./format.ts"
import { TILE_PADDING } from "./input-block.tsx"
import { useTicker } from "./ticker.ts"

const gutter = (selected: boolean) => (selected ? " ●" : "").padEnd(TILE_PADDING)

// The recent sessions under the welcome tile, lined up with the text inside it. The selection marker sits in the
// tile's padding, so selecting a row never moves its text.
export function RecentList(props: { entries: SessionEntry[]; selected: number | null; width: number }) {
  const inner = () => props.width - 2 * TILE_PADDING
  const minute = useTicker(() => true, 60_000)
  const rows = () => {
    minute()
    const now = Date.now()
    return props.entries.map((entry, index) => {
      const ago = formatAgo(entry.modified, now)
      const room = inner() - Bun.stringWidth(ago)
      const title = cut(entry.title || NO_PROMPT, Math.max(0, room - 2))
      const gap = " ".repeat(Math.max(1, room - Bun.stringWidth(title)))
      return { selected: props.selected === index, title, color: entry.title ? theme.text : theme.muted, gap, ago }
    })
  }
  return (
    <box flexDirection="column" width={props.width} flexShrink={0}>
      <text fg={theme.muted}>{`${gutter(false)}Recent`}</text>
      <Index each={rows()}>
        {(row) => (
          <text wrapMode="none">
            <span style={{ fg: theme.accent }}>{gutter(row().selected)}</span>
            {/* A span never drops bold once set, so the selected title is its own span. */}
            <Show when={row().selected} fallback={<span style={{ fg: row().color }}>{row().title}</span>}>
              <span style={{ fg: theme.accent, bold: true }}>{row().title}</span>
            </Show>
            {row().gap}
            <span style={{ fg: theme.muted }}>{row().ago}</span>
          </text>
        )}
      </Index>
    </box>
  )
}
