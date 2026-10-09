// Rows 0-1 are the ascender, 2-6 the x-height, 7 the descender.
const GLYPHS: Record<string, string[]> = {
  y: ["....", "....", "#..#", "#..#", "#..#", "####", "...#", "####"],
  e: ["....", "....", "####", "#..#", "####", "#...", "####", "...."],
  l: ["#", "#", "#", "#", "#", "#", "#", "."],
  o: ["....", "....", "####", "#..#", "#..#", "#..#", "####", "...."],
  w: [".....", ".....", "#...#", "#...#", "#.#.#", "#.#.#", "#####", "....."],
  c: ["....", "....", "####", "#...", "#...", "#...", "####", "...."],
  d: ["...#", "...#", "####", "#..#", "#..#", "#..#", "####", "...."],
}

// Palette keys: "yellow" is L (light), a, A (deep); "code" is M (light), b, B (deep).
function tone(y: number, word: "yellow" | "code"): string {
  if (y <= 2) return word === "yellow" ? "L" : "M"
  if (y >= 5) return word === "yellow" ? "A" : "B"
  return word === "yellow" ? "a" : "b"
}

export function wordmark(): string[] {
  const rows: string[] = Array.from({ length: 8 }, () => "")
  "yellowcode".split("").forEach((letter, index) => {
    const glyph = GLYPHS[letter] ?? []
    const word = index < 6 ? "yellow" : "code"
    rows.forEach((_, y) => {
      rows[y] += (index === 0 ? "" : ".") + (glyph[y] ?? "").replaceAll("#", tone(y, word))
    })
  })
  return rows
}
