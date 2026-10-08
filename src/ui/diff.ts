import type { Hunk } from "../session/types.ts"

export type DiffRow = { kind: "add" | "del" | "ctx"; number: number; text: string } | { kind: "gap" }

// Keeps `context` unchanged lines around each change; dropped lines become a single gap row.
export function diffRows(hunks: readonly Hunk[], context = 1): DiffRow[] {
  const rows: DiffRow[] = []
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    const lines: Extract<DiffRow, { number: number }>[] = []
    for (const line of hunk.lines) {
      const text = line.slice(1)
      if (line.startsWith("+")) lines.push({ kind: "add", number: newLine++, text })
      else if (line.startsWith("-")) lines.push({ kind: "del", number: oldLine++, text })
      else if (line.startsWith(" ")) {
        lines.push({ kind: "ctx", number: newLine, text })
        oldLine++
        newLine++
      }
    }
    const keep = lines.map(
      (row, index) =>
        row.kind !== "ctx" ||
        lines.slice(Math.max(0, index - context), index + context + 1).some((near) => near.kind !== "ctx"),
    )
    lines.forEach((row, index) => {
      if (!keep[index]) return
      if ((index === 0 || !keep[index - 1]) && rows.length > 0) rows.push({ kind: "gap" })
      rows.push(row)
    })
  }
  return rows
}

export function addedRows(content: string): DiffRow[] {
  return content
    .replace(/\n$/, "")
    .split("\n")
    .map((text, index) => ({ kind: "add", number: index + 1, text }))
}
