export const CAT_PALETTE: Record<string, string> = {
  K: "#3A2618",
  Y: "#FFD23F",
  D: "#E6A51E",
  L: "#FFE88F",
  C: "#FFF3CF",
  P: "#F59C9C",
  E: "#2E1F16",
  W: "#FFFFFF",
}

export const CAT: string[] = [
  "...KK........KK.......",
  "..KYYK......KYYK......",
  "..KYPYK....KYPYK......",
  "..KYPYYKKKKYYPYK......",
  ".KYYYYYDYYDYYYYYK.....",
  ".KYLYYYYDDYYYYYDK..KK.",
  ".KYYYWEYYYYWEYYDK.KYYK",
  "KKYYYEEYYYYEEYYYKKKDK.",
  ".KYPYYYYPPYYYYPDK.KYK.",
  "KKYYYYYEYYEYYYYYKKKDK.",
  ".KYYYYYYEEYYYYYDK.KYK.",
  "..KYYYYYYYYYYYYK..KDK.",
  "..KYYCCCCCCCCYYK..KYK.",
  ".KDDYCCCCCCCCYDDK.KDK.",
  ".KYYYYCCCCCCYYYYK.KYK.",
  ".KDDYYYCCCCYYYDDK.KDK.",
  ".KYYYKYYYYYYKYYYKKYK..",
  ".KDDDKDDDDDDKDDDDYDK..",
  ".KCCCKKKKKKKKCCCK.....",
  "..KKK........KKK......",
]

const setPixel = (rows: string[], y: number, x: number, key: string) => {
  const row = rows[y] ?? ""
  rows[y] = row.slice(0, x) + key + row.slice(x + 1)
}

export function blinkFrame(art: string[]): string[] {
  const rows = [...art]
  for (const x of [5, 6, 11, 12]) setPixel(rows, 6, x, "Y")
  return rows
}

export function swayFrame(art: string[]): string[] {
  return art.map((row, y) => (y >= 4 && y <= 6 ? row.slice(0, 17) + row.slice(18, 22) + "." : row))
}
