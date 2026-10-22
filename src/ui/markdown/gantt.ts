export type GanttTask = { section: string; name: string; start: number; end: number; tags: string[] }
export type Gantt = { title: string; tasks: GanttTask[] }

export const DAY = 86_400_000

const SETTINGS = /^(dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|inclusiveEndDates)\b/
const TAGS = /^(done|active|crit|milestone)$/

function date(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null
}

function duration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([dwh])$/.exec(text.trim())
  if (!match) return null
  const unit = match[2] === "w" ? 7 * DAY : match[2] === "h" ? DAY / 24 : DAY
  return Number(match[1]) * unit
}

// Mermaid's gantt with YYYY-MM-DD dates. A task reads `name : [tags,] [id,] [start,] end`, where start is a date or
// `after id` and end a date or a duration; with no start it follows the task before it.
export function parseGantt(code: string): Gantt | null {
  const lines = code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"))
  if (!/^gantt\b/.test(lines[0] ?? "")) return null
  let title = ""
  let section = ""
  const tasks: GanttTask[] = []
  const byId = new Map<string, GanttTask>()
  for (const line of lines.slice(1)) {
    if (line.startsWith("title ")) title = line.slice(6).trim()
    else if (line.startsWith("section ")) section = line.slice(8).trim()
    else if (!SETTINGS.test(line)) {
      const match = /^(.+?)\s*:\s*(.+)$/.exec(line)
      if (!match) continue
      const parts = (match[2] ?? "").split(",").map((part) => part.trim())
      const tags: string[] = []
      while (TAGS.test(parts[0] ?? "")) tags.push(parts.shift() ?? "")
      const id = parts.length === 3 ? parts.shift() : undefined
      let start = tasks.at(-1)?.end ?? null
      if (parts.length === 2) {
        const from = parts.shift() ?? ""
        const after = /^after\s+(\S+)$/.exec(from)
        start = after ? (byId.get(after[1] ?? "")?.end ?? null) : date(from)
      }
      const last = parts[0] ?? ""
      const span = duration(last)
      const end = date(last) ?? (start === null || span === null ? null : start + span)
      if (start === null || end === null) continue
      const task = { section, name: (match[1] ?? "").trim(), start, end: Math.max(start, end), tags }
      tasks.push(task)
      if (id) byId.set(id, task)
    }
  }
  return { title, tasks }
}
