import type { RGBA } from "@opentui/core"
import { theme } from "../../theme/theme.ts"
import type { Span } from "../notice.ts"
import { cut, wrapLines } from "../format.ts"
import type { DialogItem, DialogText } from "./list.ts"

// The detail pane of a two-pane tab: a header, label and value rows, and name lists.
export const KEY_WIDTH = 14
const NAME_LINES = 2
const VALUE_LINES = 3

export const text = (id: string, spans: Span[], indent = 0): DialogText => ({ id, spans, indent })
export const blank = (id: string) => text(id, [])

export function header(name: string, state: Span): DialogText {
  return text("header", [{ text: name, fg: theme.text, bold: true }, { text: "  ", fg: theme.text }, state])
}

export function title(id: string, label: string): DialogText {
  return text(id, [{ text: label, fg: theme.accent, bold: true }])
}

// A muted label and its value; a long value wraps under itself.
export function fact(id: string, label: string, value: string, width: number, fg: RGBA = theme.text): DialogText[] {
  return wrapLines(value, width - KEY_WIDTH, VALUE_LINES).map((part, index) =>
    text(`${id}-${index}`, [
      { text: (index === 0 ? label : "").padEnd(KEY_WIDTH), fg: theme.muted },
      { text: part, fg },
    ]),
  )
}

// Names packed into lines of `width`, joined by ", ".
function pack(list: string[], width: number): string[][] {
  const lines: string[][] = []
  for (const name of list) {
    const last = lines.at(-1)
    if (last && Bun.stringWidth(`${[...last, name].join(", ")},`) <= width) last.push(name)
    else lines.push([name])
  }
  return lines
}

// Names joined by commas. Past two lines they end in "…", and a `▸ N more` row, `<id>-more`, opens the rest.
export function names(
  id: string,
  list: string[],
  width: number,
  options: { label?: string; open: boolean },
): DialogItem[] {
  const indent = options.label === undefined ? 0 : KEY_WIDTH
  const room = Math.max(1, width - indent)
  const lines = pack(list, room)
  if (lines.length <= NAME_LINES) return nameLines(id, lines, room, options.label, false)
  const cutLines = lines.slice(0, NAME_LINES).map((line) => line.slice())
  const last = cutLines[NAME_LINES - 1] ?? []
  while (last.length > 1 && Bun.stringWidth(`${last.join(", ")}, …`) > room) last.pop()
  const hidden = list.length - cutLines.flat().length
  const mark = options.open ? "▾" : "▸"
  return [
    ...nameLines(id, options.open ? lines : cutLines, room, options.label, !options.open),
    { id: `${id}-more`, label: `${" ".repeat(indent)}${mark} ${hidden} more`, labelColor: theme.muted },
  ]
}

function nameLines(id: string, lines: string[][], room: number, label: string | undefined, cutShort: boolean) {
  return lines.map((line, index) => {
    const end = cutShort && index === lines.length - 1 ? ", …" : index < lines.length - 1 ? "," : ""
    const lead = label === undefined ? [] : [{ text: (index === 0 ? label : "").padEnd(KEY_WIDTH), fg: theme.muted }]
    return text(`${id}-${index}`, [...lead, { text: cut(`${line.join(", ")}${end}`, room), fg: theme.text }])
  })
}
