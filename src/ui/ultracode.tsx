import { RGBA, TextAttributes, type TextRenderable } from "@opentui/core"
import { Index } from "solid-js"
import { ultracodeGradient, ultracodePalette } from "../theme/brand.ts"
import { theme } from "../theme/theme.ts"
import { mix } from "./color.ts"
import { cut } from "./format.ts"

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

// `label` is drawn muted two cells into the rule and `hint` two cells from its end, each only when it fits.
export function InputEdge(props: {
  width: number
  ultracode: boolean
  frame: number
  glyph?: string
  label?: string
  hint?: string
  // A clickable hint is cut to fit rather than left out.
  hintColor?: RGBA
  onHint?: () => void
  color?: RGBA
}) {
  const glyph = () => props.glyph ?? EDGE
  const width = () => Math.max(0, props.width)
  const label = () => {
    const text = props.label ? ` ${props.label} ` : ""
    return text && LABEL_INDENT + Bun.stringWidth(text) + LABEL_INDENT <= width() ? text : ""
  }
  const after = () => (label() ? LABEL_INDENT + Bun.stringWidth(label()) : 0)
  const hint = () => {
    const text = props.hint ? ` ${props.hint} ` : ""
    const room = width() - after() - 2 * LABEL_INDENT
    if (!text || Bun.stringWidth(text) <= room) return text
    return props.onHint && room > 4 ? `${cut(text.trimEnd(), room - 1)} ` : ""
  }
  const before = () => width() - LABEL_INDENT - Bun.stringWidth(hint())
  const cells = (from: number, to: number) =>
    props.ultracode ? (
      <Index each={range(from, to)}>
        {(x) => <span style={{ fg: edgeColor(x(), width(), props.frame) }}>{glyph()}</span>}
      </Index>
    ) : (
      <span style={{ fg: props.color ?? theme.frame }}>{glyph().repeat(Math.max(0, to - from))}</span>
    )
  let edge: TextRenderable | undefined
  return (
    <text
      ref={(element: TextRenderable) => (edge = element)}
      flexShrink={0}
      wrapMode="none"
      onMouseDown={(event) => {
        const x = event.x - (edge?.x ?? 0)
        if (props.onHint && hint() && x >= before() && x < width() - LABEL_INDENT) props.onHint()
      }}
    >
      {label() ? (
        <>
          {cells(0, LABEL_INDENT)}
          <span style={{ fg: theme.muted }}>{label()}</span>
        </>
      ) : null}
      {cells(after(), hint() ? before() : width())}
      {hint() ? (
        <>
          <span style={{ fg: props.hintColor ?? theme.muted }}>{hint()}</span>
          {cells(width() - LABEL_INDENT, width())}
        </>
      ) : null}
    </text>
  )
}
