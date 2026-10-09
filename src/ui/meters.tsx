import type { RGBA } from "@opentui/core"
import { theme } from "../theme/theme.ts"

// U+1FB0B, a sextant that fills the middle third of the cell.
const THIRD = "🬋"

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function levelColor(fraction: number): RGBA {
  if (fraction < 0.5) return theme.success
  if (fraction < 0.8) return theme.warning
  return theme.error
}

export function ThirdBar(props: { fraction: number; width: number; color: RGBA }) {
  const filled = () => clamp(Math.round(props.fraction * props.width), 0, props.width)
  return (
    <text flexShrink={0} wrapMode="none">
      <span style={{ fg: props.color }}>{THIRD.repeat(filled())}</span>
      <span style={{ fg: theme.frame }}>{THIRD.repeat(props.width - filled())}</span>
    </text>
  )
}
