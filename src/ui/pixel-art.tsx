import type { RGBA } from "@opentui/core"
import { Index } from "solid-js"

type Cell = { char: string; fg: RGBA | undefined; bg: RGBA | undefined }

// Two pixel rows share one cell row: the top pixel is the upper half, the bottom pixel the lower half.
function cell(top: RGBA | undefined, bottom: RGBA | undefined): Cell {
  if (top && bottom) {
    if (top.equals(bottom)) return { char: "█", fg: top, bg: undefined }
    // A terminal's default foreground cannot be used as a background, so it stays the foreground.
    if (bottom.intent === "default") return { char: "▄", fg: bottom, bg: top }
    return { char: "▀", fg: top, bg: bottom }
  }
  if (top) return { char: "▀", fg: top, bg: undefined }
  if (bottom) return { char: "▄", fg: bottom, bg: undefined }
  return { char: " ", fg: undefined, bg: undefined }
}

export function pixelCells(art: string[], palette: Record<string, RGBA>): Cell[][] {
  const rows: Cell[][] = []
  for (let y = 0; y < art.length; y += 2) {
    const top = art[y] ?? ""
    const bottom = art[y + 1] ?? ""
    rows.push(top.split("").map((key, x) => cell(palette[key], palette[bottom[x] ?? "."])))
  }
  return rows
}

export function PixelArt(props: { art: string[]; palette: Record<string, RGBA> }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <Index each={pixelCells(props.art, props.palette)}>
        {(row) => (
          <text flexShrink={0} wrapMode="none">
            <Index each={row()}>{(item) => <span style={{ fg: item().fg, bg: item().bg }}>{item().char}</span>}</Index>
          </text>
        )}
      </Index>
    </box>
  )
}
