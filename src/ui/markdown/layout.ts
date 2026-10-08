const width = (text: string): number => Bun.stringWidth(text)

function breakWord(word: string, max: number): string[] {
  const pieces: string[] = []
  let piece = ""
  for (const char of word) {
    if (piece && width(piece + char) > max) {
      pieces.push(piece)
      piece = ""
    }
    piece += char
  }
  if (piece) pieces.push(piece)
  return pieces
}

// Word wrap; words longer than the width are broken across lines.
export function wrapText(text: string, max: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (width(candidate) <= max) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      const pieces = width(word) > max ? breakWord(word, max) : [word]
      lines.push(...pieces.slice(0, -1))
      line = pieces.at(-1) ?? ""
    }
    lines.push(line)
  }
  return lines
}

const longestWord = (text: string): number => Math.max(1, ...text.split(/\s+/).map(width))

function capWidest(widths: number[], available: number): number[] {
  let cap = Math.max(...widths)
  const capped = () => widths.map((value) => Math.min(value, cap))
  const sum = () => capped().reduce((total, value) => total + value, 0)
  while (cap > 1 && sum() > available) cap -= 1
  const result = capped()
  let left = available - sum()
  for (let index = result.length - 1; left > 0 && index >= 0; index--) {
    if ((result[index] ?? 0) < (widths[index] ?? 0)) {
      result[index] = (result[index] ?? 0) + 1
      left -= 1
    }
  }
  return result
}

// Column widths that fit `available` cells of content. Columns start at their longest word
// and grow toward their natural width; if even the longest words do not fit, only the widest
// columns are cut down to a shared cap and wrapText breaks their words. Rounding leftovers go to
// the last columns, so the first columns only ever shrink while a table streams in.
export function fitColumns(columns: string[][], available: number): number[] {
  const natural = columns.map((cells) => Math.max(1, ...cells.map(width)))
  const total = natural.reduce((sum, value) => sum + value, 0)
  if (total <= available) return natural

  const minimum = columns.map((cells) => Math.max(...cells.map(longestWord)))
  const minimumTotal = minimum.reduce((sum, value) => sum + value, 0)
  if (minimumTotal >= available) return capWidest(minimum, available)

  const room = available - minimumTotal
  const wants = natural.map((value, index) => value - (minimum[index] ?? 0))
  const wantTotal = wants.reduce((sum, value) => sum + value, 0)
  const widths = minimum.map((value, index) => value + Math.floor(((wants[index] ?? 0) / wantTotal) * room))
  let left = available - widths.reduce((sum, value) => sum + value, 0)
  for (let index = widths.length - 1; left > 0 && index >= 0; index--) {
    if ((widths[index] ?? 0) < (natural[index] ?? 0)) {
      widths[index] = (widths[index] ?? 0) + 1
      left -= 1
    }
  }
  return widths
}
