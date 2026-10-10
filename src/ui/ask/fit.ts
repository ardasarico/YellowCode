import { cut } from "../format.ts"

export function fitHints(full: string, short: string, width: number): string {
  return Bun.stringWidth(full) <= width ? full : short
}

// Numbered page labels that cut the longest headers first so the bar, with Submit, fits `width` cells on one row.
export function pageLabels(headers: string[], width: number): string[] {
  const labels = headers.map((header, index) => `${index + 1}. ${header}`)
  const room = (limit: number) => labels.reduce((sum, label) => sum + Math.min(Bun.stringWidth(label), limit), 0)
  const budget = width - 2 - 6 - headers.length * 5
  let limit = Math.max(...labels.map((label) => Bun.stringWidth(label)), 0)
  while (limit > 4 && room(limit) > budget) limit--
  return [...labels.map((label) => cut(label, limit)), "Submit"]
}
