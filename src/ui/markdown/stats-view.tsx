import { For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import type { Stat } from "./stats.ts"

// Border and padding around a card's text.
const FRAME = 4

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let at = 0; at < items.length; at += size) rows.push(items.slice(at, at + size))
  return rows
}

function noteColor(stat: Stat) {
  if (stat.tone === "good") return theme.success
  if (stat.tone === "bad") return theme.error
  return theme.muted
}

export function StatsView(props: { stats: Stat[]; width: number }) {
  const longest = () =>
    Math.max(
      ...props.stats.map((stat) =>
        Math.max(Bun.stringWidth(stat.label), Bun.stringWidth(stat.note ? `${stat.value} ${stat.note}` : stat.value)),
      ),
    )
  const inner = () => Math.max(1, Math.min(longest(), props.width - FRAME))
  const perRow = () => Math.max(1, Math.floor((props.width + 1) / (inner() + FRAME + 1)))
  const rows = () => chunk(props.stats, perRow())
  return (
    <box flexDirection="column">
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" gap={1}>
            <For each={row}>
              {(stat) => (
                <box
                  border
                  borderStyle="rounded"
                  borderColor={theme.frame}
                  paddingX={1}
                  width={inner() + FRAME}
                  flexShrink={0}
                >
                  <text>
                    <span style={{ fg: theme.accent, bold: true }}>{stat.value}</span>
                    <Show when={stat.note}>
                      <span style={{ fg: noteColor(stat) }}>{` ${stat.note}`}</span>
                    </Show>
                  </text>
                  <text fg={theme.muted}>{stat.label}</text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
