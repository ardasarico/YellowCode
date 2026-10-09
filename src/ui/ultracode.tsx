import { RGBA, TextAttributes } from "@opentui/core"
import { Index } from "solid-js"
import { ultracodeGradient, ultracodePalette } from "../theme/brand.ts"
import { theme } from "../theme/theme.ts"
import { mix } from "./color.ts"

const WORD = "ultracode".split("")
const WHITE = RGBA.fromInts(255, 255, 255)
// Quarter-height bar at the top of the cell, so the line hugs the block above it.
const EDGE = "🮂"

const wrap = (value: number, size: number) => ((value % size) + size) % size

function letterColor(index: number, frame: number): RGBA {
  const palette = ultracodePalette(theme.rgb)
  const base = palette[wrap(index - Math.floor(frame / 1.5), palette.length)] ?? WHITE
  if (!theme.rgb) return base
  const highlight = 0.85 * Math.max(0, 1 - Math.abs(index - (wrap(frame, 40) - 4)) / 2.5)
  return mix(base, WHITE, highlight)
}

function gradientAt(position: number): RGBA {
  const stops = ultracodeGradient(theme.rgb)
  const scaled = wrap(position, 1) * stops.length
  const index = Math.floor(scaled)
  const from = stops[index % stops.length] ?? WHITE
  return mix(from, stops[(index + 1) % stops.length] ?? from, scaled - index)
}

export function UltracodeWord(props: { frame: number }) {
  return (
    <text attributes={TextAttributes.BOLD}>
      <Index each={WORD}>
        {(letter, index) => <span style={{ fg: letterColor(index, props.frame) }}>{letter()}</span>}
      </Index>
    </text>
  )
}

export function BottomEdge(props: { width: number; ultracode: boolean; frame: number }) {
  const columns = () => Array.from({ length: props.width }, (_, x) => x)
  return (
    <text flexShrink={0} wrapMode="none">
      {props.ultracode ? (
        <Index each={columns()}>
          {(x) => <span style={{ fg: gradientAt((x() / props.width) * 0.9 - props.frame * 0.004) }}>{EDGE}</span>}
        </Index>
      ) : (
        <span style={{ fg: theme.frame }}>{EDGE.repeat(props.width)}</span>
      )}
    </text>
  )
}
