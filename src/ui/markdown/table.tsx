import type { Tokens } from "marked"
import { createMemo, For } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { toRuns } from "./inline.tsx"
import { fitColumns, wrapText } from "./layout.ts"

type Segment = { text: string; frame?: boolean; bold?: boolean }

const plain = (cell: Tokens.TableCell): string =>
  toRuns(cell.tokens, { fg: theme.text }, true)
    .map((run) => run.text)
    .join("")

export function tableSegments(token: Tokens.Table, width: number): Segment[] {
  const header = token.header.map(plain)
  const rows = token.rows.map((row) => row.map(plain))
  const columns = header.map((cell, index) => [cell, ...rows.map((row) => row[index] ?? "")])
  const widths = fitColumns(columns, Math.max(header.length, width - (3 * header.length + 1)))

  const segments: Segment[] = []
  const rule = (left: string, middle: string, right: string) => {
    segments.push({ text: left + widths.map((cell) => "─".repeat(cell + 2)).join(middle) + right, frame: true })
    segments.push({ text: "\n" })
  }
  const row = (cells: string[], bold: boolean) => {
    const wrapped = widths.map((cellWidth, index) => wrapText(cells[index] ?? "", cellWidth))
    const height = Math.max(...wrapped.map((lines) => lines.length))
    for (let line = 0; line < height; line++) {
      segments.push({ text: "│", frame: true })
      wrapped.forEach((lines, index) => {
        const text = lines[line] ?? ""
        const pad = Math.max(0, (widths[index] ?? 0) - Bun.stringWidth(text))
        const align = token.align[index]
        const before = align === "right" ? pad : align === "center" ? Math.floor(pad / 2) : 0
        segments.push({ text: ` ${" ".repeat(before)}${text}${" ".repeat(pad - before)} `, bold })
        segments.push({ text: "│", frame: true })
      })
      segments.push({ text: "\n" })
    }
  }

  rule("┌", "┬", "┐")
  row(header, true)
  for (const cells of rows) {
    rule("├", "┼", "┤")
    row(cells, false)
  }
  rule("└", "┴", "┘")
  segments.pop()
  return segments
}

export function Table(props: { token: Tokens.Table; width: number }) {
  const segments = createMemo(() => tableSegments(props.token, props.width - 2))
  return (
    <box paddingLeft={2}>
      <text fg={theme.text} wrapMode="none">
        <For each={segments()}>
          {(segment) => (
            <span style={{ fg: segment.frame ? theme.frame : theme.text, bold: segment.bold === true }}>
              {segment.text}
            </span>
          )}
        </For>
      </text>
    </box>
  )
}
