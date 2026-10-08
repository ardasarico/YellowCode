import { RGBA } from "@opentui/core"

export function claudeColor(rgb: boolean): RGBA {
  return rgb ? RGBA.fromHex("#d97757") : RGBA.fromIndex(3)
}
