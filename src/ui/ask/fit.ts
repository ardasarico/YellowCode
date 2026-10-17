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

const LABEL_SHARE = 0.4
// Below this the labels wrap into towers, so the steps are cut instead.
const LABEL_FLOOR = 16
// The cursor mark and the gap after the label column; each step is ` ○ Yes `.
export const LABEL_EXTRA = 4
export const STEP_EXTRA = 4

const widest = (texts: string[]) => Math.max(1, ...texts.map((text) => Bun.stringWidth(text)))

// Widths for a matrix: `label` for the label column's text, which wraps longer labels; steps are cut to `limit`,
// the cursor's step to `cursorLimit`. The label column takes up to 40% of the width and narrows to its longest word
// to make room for the steps; when even that is not enough, every step but the cursor's is cut. The cursor's step is
// left room as if it were the widest, so the cuts stay put as the cursor moves.
export function matrixColumns(
  labels: string[],
  scale: string[],
  width: number,
): { label: number; limit: number; cursorLimit: number } {
  const preferred = Math.min(Math.floor(width * LABEL_SHARE), widest(labels))
  const narrowest = Math.min(preferred, Math.max(LABEL_FLOOR, widest(labels.flatMap((label) => label.split(/\s+/)))))
  const steps = scale.map((step) => Bun.stringWidth(step))
  const room = width - LABEL_EXTRA
  const stepsWidth = (limit: number) => steps.reduce((sum, step) => sum + Math.min(step, limit) + STEP_EXTRA, 0)
  const full = stepsWidth(Infinity)
  if (narrowest + full <= room) {
    return { label: Math.min(preferred, room - full), limit: Infinity, cursorLimit: Infinity }
  }
  const top = Math.max(...steps)
  const others = (limit: number) => stepsWidth(limit) - Math.min(top, limit)
  let limit = top
  while (limit > 1 && narrowest + others(limit) + top > room) limit--
  return { label: narrowest, limit, cursorLimit: Math.max(1, Math.min(top, room - narrowest - others(limit))) }
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
