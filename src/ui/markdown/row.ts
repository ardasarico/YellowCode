import { is } from "./blocks.ts"
import type { Entry } from "./details.ts"

export const ROW_RULE = " │ "

export function rowCode(entry: Entry) {
  const code = is(entry, "code")
  return code?.lang?.trim().toLowerCase() === "row" ? code : undefined
}

export function parseRow(text: string): string[] | null {
  const sections = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return sections.length ? sections : null
}

// Sections in order, as many per line as fit `width` with the rule between them; one too wide gets a line of its own.
export function packRow(widths: number[], width: number): number[][] {
  const lines: number[][] = []
  let used = 0
  widths.forEach((size, index) => {
    const line = lines.at(-1)
    if (line && used + ROW_RULE.length + size <= width) {
      line.push(index)
      used += ROW_RULE.length + size
    } else {
      lines.push([index])
      used = size
    }
  })
  return lines
}
