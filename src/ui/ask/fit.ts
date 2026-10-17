import { cut } from "../format.ts"

export function fitHints(full: string, short: string, width: number): string {
  return Bun.stringWidth(full) <= width ? full : short
}

// Word-wrapped rows of `text` in `width` cells, the first row `lead` cells shorter. A word wider than its row is
// broken. Past `max` rows the last row is cut with "…".
export function wrapRows(text: string, width: number, max = Infinity, lead = 0): string[] {
  const rows: string[] = []
  let row = ""
  const room = () => Math.max(1, width - (rows.length === 0 ? lead : 0))
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const joined = row ? `${row} ${word}` : word
    if (Bun.stringWidth(joined) <= room()) {
      row = joined
      continue
    }
    if (row) rows.push(row)
    row = ""
    for (const char of word) {
      if (row && Bun.stringWidth(row + char) > room()) {
        rows.push(row)
        row = ""
      }
      row += char
    }
  }
  rows.push(row)
  if (rows.length <= max) return rows
  const last = cut(rows.slice(max - 1).join(" "), Math.max(1, width - (max === 1 ? lead : 0)))
  return [...rows.slice(0, max - 1), last.replace(/\s+…$/, "…")]
}

// `page` is null on a fold marker; Submit's page is the number of questions.
export type PageTab = { text: string; page: number | null }

const SEPARATOR = 5
const SHORTEST = 12
const LONGEST = 20

const barWidth = (tabs: PageTab[], indicator: string) =>
  2 +
  tabs.reduce((sum, tab, index) => sum + Bun.stringWidth(tab.text) + (index > 0 ? SEPARATOR : 0), 0) +
  (indicator ? Bun.stringWidth(indicator) + 2 : 0)

// Every page on one row, cutting the longest headers first. When even short labels do not fit, the current page and
// the neighbours that fit stay, the rest fold into `‹ +N` / `+N ›`, and `N of M` goes on the right.
export function pageWindow(
  headers: string[],
  current: number,
  answered: boolean[],
  width: number,
): { tabs: PageTab[]; indicator: string } {
  const count = headers.length
  const labels = (limit: number) =>
    headers.map((header, index) => cut(`${index + 1}. ${header}`, limit) + (answered[index] ? " ✓" : ""))
  const tabsOf = (texts: string[], from: number, to: number): PageTab[] => [
    ...(from > 0 ? [{ text: `‹ +${from}`, page: null }] : []),
    ...texts.slice(from, to + 1).map((text, offset) => ({ text, page: from + offset })),
    ...(to < count - 1 ? [{ text: `+${count - 1 - to} ›`, page: null }] : []),
    { text: "Submit", page: count },
  ]
  let limit = Math.max(...headers.map((header, index) => Bun.stringWidth(`${index + 1}. ${header}`)), 0)
  // No limit fits when even the shortest labels do not.
  if (limit > SHORTEST && barWidth(tabsOf(labels(SHORTEST), 0, count - 1), "") > width) limit = SHORTEST
  while (limit > SHORTEST && barWidth(tabsOf(labels(limit), 0, count - 1), "") > width) limit--
  const all = tabsOf(labels(limit), 0, count - 1)
  if (barWidth(all, "") <= width) return { tabs: all, indicator: "" }

  const texts = labels(LONGEST)
  const indicator = current < count ? `${current + 1} of ${count}` : ""
  let from = Math.min(current, count - 1)
  let to = from
  for (let grew = true; grew;) {
    grew = false
    if (to < count - 1 && barWidth(tabsOf(texts, from, to + 1), indicator) <= width) {
      to++
      grew = true
    }
    if (from > 0 && barWidth(tabsOf(texts, from - 1, to), indicator) <= width) {
      from--
      grew = true
    }
  }
  return { tabs: tabsOf(texts, from, to), indicator }
}
