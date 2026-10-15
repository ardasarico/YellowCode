import { is } from "./blocks.ts"
import type { Entry } from "./details.ts"

export type Stat = { label: string; value: string; note?: string; tone?: "good" | "bad" }

const LINE = /^([^:]+?)\s*:\s*(.+?)(?:\s+\(([^)]*)\))?$/
const TONE = /,\s*(good|bad)$/

export function parseStats(text: string): Stat[] | null {
  const stats: Stat[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const match = LINE.exec(line.trim())
    if (!match) return null
    const [, label = "", value = "", note] = match
    const tone = note ? TONE.exec(note)?.[1] : undefined
    const shown = note?.replace(TONE, "").trim()
    stats.push({
      label,
      value,
      ...(shown ? { note: shown } : {}),
      ...(tone === "good" || tone === "bad" ? { tone } : {}),
    })
  }
  return stats.length ? stats : null
}

export function statsCode(entry: Entry) {
  const code = is(entry, "code")
  return code?.lang?.trim().toLowerCase() === "stats" ? code : undefined
}
