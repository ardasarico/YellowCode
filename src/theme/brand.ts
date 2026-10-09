import { RGBA } from "@opentui/core"

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max"

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"]

const EFFORT_HEX: Record<EffortLevel, string> = {
  low: "#6FA8DC",
  medium: "#7CC68A",
  high: "#FFD23F",
  xhigh: "#FF9A3C",
  max: "#FF5C5C",
}
const EFFORT_ANSI: Record<EffortLevel, number> = { low: 4, medium: 2, high: 3, xhigh: 9, max: 1 }

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

export function effortColor(level: EffortLevel, rgb: boolean): RGBA {
  return rgb ? RGBA.fromHex(EFFORT_HEX[level]) : RGBA.fromIndex(EFFORT_ANSI[level])
}

export function ultracodePalette(rgb: boolean): RGBA[] {
  return rgb ? ULTRACODE_HEX.map((value) => RGBA.fromHex(value)) : [RGBA.fromIndex(5), RGBA.fromIndex(13)]
}

export function ultracodeGradient(rgb: boolean): RGBA[] {
  return rgb ? GRADIENT_HEX.map((value) => RGBA.fromHex(value)) : [RGBA.fromIndex(5)]
}
