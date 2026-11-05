import type { RGBA } from "@opentui/core"
import { For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import type { Stat } from "./stats.ts"

// Border and padding around a card's text.
const FRAME = 4
const STRIP_MOST = 5
const RULE = " │ "

type Piece = { text: string; fg: RGBA; bold?: boolean }

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

const shown = (stat: Stat) => (stat.note ? `${stat.value} ${stat.note}` : stat.value)

const sectionWidth = (count: number, width: number) => Math.floor((width - RULE.length * (count - 1)) / count)

function fitsStrip(stats: Stat[], width: number): boolean {
  if (stats.length > STRIP_MOST) return false
  const room = sectionWidth(stats.length, width)
  return stats.every((stat) => Bun.stringWidth(shown(stat)) < room && Bun.stringWidth(stat.label) < room)
}

const rule = (at: number): Piece[] => (at ? [{ text: RULE, fg: theme.frame }] : [])

// Cards on the theme's tile colour; a theme without one keeps a border so the cards still read apart.
const tileLook = () =>
  theme.tile
    ? { backgroundColor: theme.tile, paddingY: 1 }
    : { border: true, borderStyle: "rounded" as const, borderColor: theme.frame }

function Line(props: { pieces: Piece[] }) {
  return (
    <text wrapMode="none">
      <For each={props.pieces}>{(piece) => <span style={{ fg: piece.fg, bold: piece.bold }}>{piece.text}</span>}</For>
    </text>
  )
}

// Equal sections across the whole row: values on the first line, labels under them. Each line is one flat list of
// spans, as fragments inside a text come out of order.
function Strip(props: { stats: Stat[]; width: number }) {
  const room = () => sectionWidth(props.stats.length, props.width)
  const values = () =>
    props.stats.flatMap((stat, at): Piece[] => [
      ...rule(at),
      { text: stat.value, fg: theme.accent, bold: true },
      ...(stat.note ? [{ text: ` ${stat.note}`, fg: noteColor(stat) }] : []),
      { text: " ".repeat(Math.max(0, room() - Bun.stringWidth(shown(stat)))), fg: theme.muted },
    ])
  const labels = () =>
    props.stats.flatMap((stat, at): Piece[] => [
      ...rule(at),
      { text: stat.label + " ".repeat(Math.max(0, room() - Bun.stringWidth(stat.label))), fg: theme.muted },
    ])
  return (
    <box flexDirection="column">
      <Line pieces={values()} />
      <Line pieces={labels()} />
    </box>
  )
}

function Tiles(props: { stats: Stat[]; width: number }) {
  const longest = () =>
    Math.max(...props.stats.map((stat) => Math.max(Bun.stringWidth(stat.label), Bun.stringWidth(shown(stat)))))
  const inner = () => Math.max(1, Math.min(longest(), props.width - FRAME))
  const perRow = () => Math.max(1, Math.floor((props.width + 1) / (inner() + FRAME + 1)))
  const rows = () => chunk(props.stats, perRow())
  return (
    <box flexDirection="column" gap={theme.tile ? 1 : 0}>
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" gap={1}>
            <For each={row}>
              {(stat) => (
                <box {...tileLook()} paddingX={1} width={inner() + FRAME} flexShrink={0}>
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

export function StatsView(props: { stats: Stat[]; width: number }) {
  return (
    <Show when={fitsStrip(props.stats, props.width)} fallback={<Tiles stats={props.stats} width={props.width} />}>
      <Strip stats={props.stats} width={props.width} />
    </Show>
  )
}
