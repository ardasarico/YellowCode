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

function edgeColor(x: number, width: number, frame: number): RGBA {
  const base = gradientAt((x / width) * 0.9 - frame * 0.009)
  if (!theme.rgb) return base
  const center = wrap(frame * 3, width + 30) - 15
  const highlight = 0.85 * Math.max(0, 1 - Math.abs(x - center) / 10)
  return mix(base, WHITE, highlight)
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

export function InputEdge(props: { width: number; ultracode: boolean; frame: number; glyph?: string }) {
  const glyph = () => props.glyph ?? EDGE
  const columns = () => Array.from({ length: props.width }, (_, x) => x)
  return (
    <text flexShrink={0} wrapMode="none">
      {props.ultracode ? (
        <Index each={columns()}>
          {(x) => <span style={{ fg: edgeColor(x(), props.width, props.frame) }}>{glyph()}</span>}
        </Index>
      ) : (
        <span style={{ fg: theme.frame }}>{glyph().repeat(props.width)}</span>
      )}
    </text>
  )
}
