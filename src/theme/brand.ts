import { RGBA } from "@opentui/core"

const EFFORT_HEX = {
  low: "#6FA8DC",
  medium: "#7CC68A",
  high: "#FFD23F",
  xhigh: "#FF9A3C",
  max: "#FF5C5C",
}
const EFFORT_ANSI: Record<keyof typeof EFFORT_HEX, number> = { low: 4, medium: 2, high: 3, xhigh: 9, max: 1 }
const hasColor = (level: string): level is keyof typeof EFFORT_HEX => Object.hasOwn(EFFORT_HEX, level)

const ULTRACODE_HEX = [
  "#7B5CE0",
  "#9568EE",
  "#B07BFA",
  "#C98EFF",
  "#E39BF0",
  "#F2A4DA",
  "#E39BF0",
  "#C98EFF",
  "#B07BFA",
  "#9568EE",
]
const GRADIENT_HEX = ["#6A4FD0", "#9A6CF5", "#C98EFF", "#F2A4DA", "#C98EFF", "#9A6CF5"]

export function claudeColor(rgb: boolean): RGBA {
  return rgb ? RGBA.fromHex("#d97757") : RGBA.fromIndex(3)
}

export function yellow(rgb: boolean): RGBA {
  return rgb ? RGBA.fromHex("#FFD23F") : RGBA.fromIndex(3)
}

// A level of another name takes high's color.
export function effortColor(level: string, rgb: boolean): RGBA {
  const known = hasColor(level) ? level : "high"
  return rgb ? RGBA.fromHex(EFFORT_HEX[known]) : RGBA.fromIndex(EFFORT_ANSI[known])
}

export function ultracodePalette(rgb: boolean): RGBA[] {
  return rgb ? ULTRACODE_HEX.map((value) => RGBA.fromHex(value)) : [RGBA.fromIndex(5), RGBA.fromIndex(13)]
}

export function ultracodeGradient(rgb: boolean): RGBA[] {
  return rgb ? GRADIENT_HEX.map((value) => RGBA.fromHex(value)) : [RGBA.fromIndex(5)]
}
