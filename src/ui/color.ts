import { RGBA } from "@opentui/core"

export function mix(from: RGBA, to: RGBA, amount: number): RGBA {
  const [r1, g1, b1] = from.toInts()
  const [r2, g2, b2] = to.toInts()
  return RGBA.fromInts(
    Math.round(r1 + (r2 - r1) * amount),
    Math.round(g1 + (g2 - g1) * amount),
    Math.round(b1 + (b2 - b1) * amount),
  )
}
