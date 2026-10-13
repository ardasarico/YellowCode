import type { RGBA } from "@opentui/core"
import type { Span } from "../notice.ts"

export type DialogRow = {
  id: string
  label: string
  value?: string
  note?: string
  search?: string
  // Drawn in the gutter, and in place of ● while the row is selected.
  marker?: Span
  labelColor?: RGBA
  // A faint word in a column the rows share.
  tag?: string
  valueColor?: RGBA
  // Replaces the value while the row is selected.
  selectedValue?: string
}
// A line that cannot be selected; a text with no spans is a blank line.
export type DialogText = { id: string; spans: Span[]; indent?: number }
export type DialogItem = DialogRow | DialogText
export type DialogSection = { title: string; rows: DialogItem[] }

export type DialogLine =
  | { kind: "title"; text: string }
  | { kind: "row"; row: DialogRow }
  | { kind: "note"; text: string }
  | { kind: "text"; text: DialogText }
  | { kind: "gap" }

export type ScrollWindow = { start: number; end: number; above: number; below: number }

export const isRow = (item: DialogItem): item is DialogRow => "label" in item

// A search keeps only the matching rows; text lines describe the unfiltered view, so they go too.
export function filterSections(sections: DialogSection[], query: string): DialogSection[] {
  const needle = query.toLowerCase()
  if (!needle) return sections
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => isRow(row) && (row.search ?? row.label).toLowerCase().includes(needle)),
    }))
    .filter((section) => section.rows.length > 0)
}

export function selectableIds(sections: DialogSection[]): string[] {
  return sections.flatMap((section) => section.rows.filter(isRow).map((row) => row.id))
}

export function moveSelection(ids: string[], current: string | undefined, step: number): string | undefined {
  const index = current === undefined ? -1 : ids.indexOf(current)
  if (index === -1) return ids[0]
  return ids[Math.max(0, Math.min(ids.length - 1, index + step))]
}

// A section's title rides on its first item, and a titled section is followed by a gap unless it is the last.
export function dialogLines(sections: DialogSection[], selected: string | undefined): DialogLine[] {
  const lines: DialogLine[] = []
  for (const [position, section] of sections.entries()) {
    for (const [index, item] of section.rows.entries()) {
      if (index === 0 && section.title) lines.push({ kind: "title", text: section.title })
      if (!isRow(item)) {
        lines.push({ kind: "text", text: item })
        continue
      }
      lines.push({ kind: "row", row: item })
      if (item.id === selected && item.note) lines.push({ kind: "note", text: item.note })
    }
    if (section.title && section.rows.length > 0 && position < sections.length - 1) lines.push({ kind: "gap" })
  }
  return lines
}

const counted = (line: DialogLine) => line.kind === "row" || (line.kind === "text" && line.text.spans.length > 0)

// Lines shown at `offset` when `count` lines share `rows`: a hidden part above or below costs one row for its
// "N more" line.
function shown(count: number, rows: number, offset: number) {
  if (count <= rows) return { start: 0, end: count }
  const room = rows - (offset > 0 ? 1 : 0)
  return { start: offset, end: offset + room >= count ? count : Math.max(offset, offset + room - 1) }
}

// Keeps lines `from`..`to` in view and moves the previous offset only as far as that needs.
export function scrollWindow(lines: DialogLine[], rows: number, from: number, to: number, previous: number) {
  const count = lines.length
  const last = Math.max(0, count - rows + 1)
  let offset = count <= rows ? 0 : Math.min(Math.max(0, previous), last)
  while (offset > 0 && from < shown(count, rows, offset).start) offset--
  while (offset < last && to >= shown(count, rows, offset).end) offset++
  // An "↑ more" line in place of the first line alone shows nothing more than starting at the top.
  if (offset === 1) offset = 0
  const { start, end } = shown(count, rows, offset)
  return {
    start,
    end,
    above: lines.slice(0, start).filter(counted).length,
    below: lines.slice(end).filter(counted).length,
  } satisfies ScrollWindow
}
