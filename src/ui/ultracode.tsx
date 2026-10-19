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

const LABEL_INDENT = 2

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, x) => from + x)

// `label` is drawn muted two cells into the rule, when it fits with two rule cells after it.
export function InputEdge(props: { width: number; ultracode: boolean; frame: number; glyph?: string; label?: string }) {
  const glyph = () => props.glyph ?? EDGE
  const width = () => Math.max(0, props.width)
  const label = () => {
    const text = props.label ? ` ${props.label} ` : ""
    return text && LABEL_INDENT + Bun.stringWidth(text) + LABEL_INDENT <= width() ? text : ""
  }
  const after = () => LABEL_INDENT + Bun.stringWidth(label())
  const cells = (from: number, to: number) =>
    props.ultracode ? (
      <Index each={range(from, to)}>
        {(x) => <span style={{ fg: edgeColor(x(), width(), props.frame) }}>{glyph()}</span>}
      </Index>
    ) : (
      <span style={{ fg: theme.frame }}>{glyph().repeat(Math.max(0, to - from))}</span>
    )
  return (
    <text flexShrink={0} wrapMode="none">
      {label() ? (
        <>
          {cells(0, LABEL_INDENT)}
          <span style={{ fg: theme.muted }}>{label()}</span>
          {cells(after(), width())}
        </>
      ) : (
        cells(0, width())
      )}
    </text>
  )
}
