// Unified diff hunks as the chat draws them, for adapters whose agents hand over diffs as text.
import type { Hunk } from "../agent/tools.ts"

const lineCount = (value: string | undefined) => (value === undefined ? 1 : Number(value))

// Lines before the first hunk header (`Index:`, `---`, `+++` and the like) are left out.
export function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      const [, oldStart, oldLines, newStart, newLines] = header
      hunks.push({
        oldStart: Number(oldStart),
        oldLines: lineCount(oldLines),
        newStart: Number(newStart),
        newLines: lineCount(newLines),
        lines: [],
      })
    } else if (/^[+\- ]/.test(line)) hunks.at(-1)?.lines.push(line)
  }
  return hunks
}
