import { createMemo, Index, Show } from "solid-js"
import { defineMod, theme } from "yellowcode/mod"
import { parseRows } from "./parse.ts"

const MAX_ROWS = 50
const GAP = 2
const MIN_COLUMN = 3
const INDENT = 2
const NUMBER = /^[-+]?[\d,]*\.?\d+%?$/

const width = (text: string) => Bun.stringWidth(text)

function cut(text: string, room: number): string {
  if (width(text) <= room) return text
  const kept = Array.from(text)
  while (kept.length > 0 && width(kept.join("")) > room - 1) kept.pop()
  return `${kept.join("")}…`
}

function pad(text: string, room: number, right: boolean): string {
  const fill = " ".repeat(Math.max(0, room - width(text)))
  return right ? fill + text : text + fill
}

// Column widths that fit the room: the widest columns give way first, down to a few cells.
function columnWidths(rows: string[][], room: number): number[] {
  const count = Math.max(...rows.map((row) => row.length))
  const widths = Array.from({ length: count }, (_, column) => Math.max(...rows.map((row) => width(row[column] ?? ""))))
  const total = () => widths.reduce((sum, value) => sum + value, 0) + GAP * (count - 1)
  while (total() > room) {
    const widest = widths.indexOf(Math.max(...widths))
    if ((widths[widest] ?? 0) <= MIN_COLUMN) break
    widths[widest] = (widths[widest] ?? 0) - 1
  }
  return widths
}

function Table(props: { rows: string[][]; width: number }) {
  const header = () => props.rows[0] ?? []
  const body = () => props.rows.slice(1, MAX_ROWS + 1)
  const hidden = () => Math.max(0, props.rows.length - 1 - MAX_ROWS)
  const widths = () => columnWidths(props.rows.slice(0, MAX_ROWS + 1), props.width - INDENT)
  const numeric = () =>
    widths().map((_, column) => {
      const cells = body()
        .map((row) => (row[column] ?? "").trim())
        .filter(Boolean)
      return cells.length > 0 && cells.every((cell) => NUMBER.test(cell))
    })
  const line = (row: string[]) =>
    widths()
      .map((room, column) => pad(cut((row[column] ?? "").trim(), room), room, numeric()[column] ?? false))
      .join(" ".repeat(GAP))
      .trimEnd()
  return (
    <box flexDirection="column" paddingLeft={INDENT}>
      <text fg={theme.text} wrapMode="none">
        <span style={{ bold: true }}>{line(header())}</span>
      </text>
      <text fg={theme.frame} wrapMode="none">
        {widths()
          .map((room) => "─".repeat(room))
          .join(" ".repeat(GAP))}
      </text>
      <Index each={body()}>
        {(row) => (
          <text fg={theme.text} wrapMode="none">
            {line(row())}
          </text>
        )}
      </Index>
      <Show when={hidden() > 0}>
        <text fg={theme.muted}>{`+${hidden()} more rows`}</text>
      </Show>
    </box>
  )
}

const separatorOf = (lang: string) => (lang === "tsv" ? "\t" : ",")

export default defineMod({
  setup(mod) {
    mod.fences.add({
      langs: ["csv", "tsv"],
      // A block that does not read as a table, or has a single column, stays code.
      accept: (block) => {
        const rows = parseRows(block.code, separatorOf(block.lang))
        return rows !== null && rows.some((row) => row.length > 1)
      },
      view: (props) => {
        // A quoted cell can hold line breaks; the table keeps one line per row.
        const rows = createMemo(() =>
          (parseRows(props.code, separatorOf(props.lang)) ?? []).map((row) =>
            row.map((cell) => cell.replaceAll(/\s*\r?\n\s*/g, " ")),
          ),
        )
        return <Table rows={rows()} width={props.width} />
      },
    })
  },
})
