import { NativeImage, RGBA } from "@opentui/core"
import { Index, Show } from "solid-js"
import type { SessionEntry } from "../resume/session-list.ts"
import { yellow } from "../theme/brand.ts"
import { theme } from "../theme/theme.ts"
import { mix } from "./color.ts"
import { onBackground } from "./images.ts"
import { InputBlock, type InputBlockProps } from "./input-block.tsx"
import { blinkFrame, CAT, CAT_PALETTE, swayFrame } from "./mascot.ts"
import { PixelArt } from "./pixel-art.tsx"
import { RecentList } from "./recent-list.tsx"
import { useTicker } from "./ticker.ts"
import { wordmark } from "./wordmark.ts"

export type Workspace = { cwd: string; branch: string | null; version: string }

const CAT_COLS = 9
const CAT_ROWS = 4
const CAT_SCALE = 10
const LOGO_GAP = 2
const BLOCK_ROWS = 6
const BLOCK_WIDTH = 74
const TICK_MS = 50
export const RECENT_ROWS = 3
const WORDMARK = wordmark()
const HINTS: [string, string][] = [
  ["⇧↑↓", "effort"],
  ["⇧←→", "model"],
  ["enter", "send"],
  ["/", "commands"],
  ["↓", "recent"],
  ["ctrl+c", "quit"],
]

const hintParts = (recent: boolean) =>
  HINTS.filter(([key]) => recent || key !== "↓").flatMap(([key, label], index) => [
    { text: `${index === 0 ? "" : "   "}${key}`, isKey: true },
    { text: ` ${label}`, isKey: false },
  ])

const LOGO_ROWS = CAT_ROWS + 2 + BLOCK_ROWS + 1 + 1
const LOGO_WIDTH = CAT_COLS + LOGO_GAP + (WORDMARK[0]?.length ?? 0)

// The cat and the wordmark sit side by side: a short terminal drops both, a narrow one drops the wordmark.
// The recent sessions need their heading and a blank row too, and go before the logo does.
export function welcomeParts(
  width: number,
  height: number,
  recent: number,
): { cat: boolean; wordmark: boolean; recent: boolean } {
  const logo = height >= LOGO_ROWS
  return { cat: logo, wordmark: logo && width >= LOGO_WIDTH, recent: recent > 0 && height >= LOGO_ROWS + 2 + recent }
}

const blockWidth = (width: number) => Math.min(BLOCK_WIDTH, width - 4)

// What the welcome screen shows in a terminal of this size; the bottom row holds the workspace line.
export function welcomeLayout(width: number, height: number, recent: number) {
  return welcomeParts(blockWidth(width), height - 1, recent)
}

const catImages = new Map<string, NativeImage>()

function catImage(blink: boolean, sway: boolean): NativeImage {
  const key = `${blink}:${sway}`
  const found = catImages.get(key)
  if (found) return found
  let art = CAT
  if (sway) art = swayFrame(art)
  if (blink) art = blinkFrame(art)
  const width = (art[0]?.length ?? 0) * CAT_SCALE
  const height = art.length * CAT_SCALE
  const pixels = new Uint8Array(width * height * 4)
  art.forEach((row, y) => {
    row.split("").forEach((pixel, x) => {
      const hex = CAT_PALETTE[pixel]
      if (!hex) return
      const color = [...RGBA.fromHex(hex).toInts().slice(0, 3), 255]
      for (let sy = 0; sy < CAT_SCALE; sy++)
        for (let sx = 0; sx < CAT_SCALE; sx++)
          pixels.set(color, ((y * CAT_SCALE + sy) * width + x * CAT_SCALE + sx) * 4)
    })
  })
  const image = NativeImage.fromRgba(pixels, width, height)
  catImages.set(key, image)
  return image
}

// The cat is an image so the original pixel art can be drawn smaller than one pixel per half cell.
function Cat() {
  const tick = useTicker(() => true, TICK_MS)
  const source = () => {
    const t = tick() * TICK_MS
    return catImage(t % 3600 < 140 || (t % 11000 >= 300 && t % 11000 < 440), t % 2400 < 500)
  }
  return (
    <image
      source={onBackground(source(), theme.background)}
      width={CAT_COLS}
      height={CAT_ROWS}
      fit="fit"
      flexShrink={0}
    />
  )
}

function Hints(props: { recent: boolean }) {
  return (
    <text>
      <Index each={hintParts(props.recent)}>
        {(part) => <span style={{ fg: part().isKey ? theme.text : theme.muted }}>{part().text}</span>}
      </Index>
    </text>
  )
}

const WHITE = RGBA.fromInts(255, 255, 255)
const BLACK = RGBA.fromInts(0, 0, 0)

const brand = (hex: string) => (theme.rgb ? RGBA.fromHex(hex) : yellow(false))

// Three tones per word, light at the top and deep at the bottom; the yellow ones are the cat's own.
function wordmarkPalette(): Record<string, RGBA> {
  const text = theme.text
  const plain = text.intent === "default"
  return {
    L: brand(CAT_PALETTE.L ?? "#FFE88F"),
    a: yellow(theme.rgb),
    A: brand(CAT_PALETTE.D ?? "#E6A51E"),
    M: plain ? text : mix(text, WHITE, 0.4),
    b: text,
    B: plain ? theme.muted : mix(text, BLACK, 0.2),
  }
}

export function Welcome(props: {
  input: Omit<InputBlockProps, "width">
  workspace: Workspace
  notice: string | null
  recent: { entries: SessionEntry[]; selected: number | null }
  width: number
  height: number
  covered: boolean
}) {
  const width = () => blockWidth(props.width)
  const parts = () => welcomeLayout(props.width, props.height, props.recent.entries.length)
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
        <Show when={parts().cat}>
          <box flexDirection="row" alignItems="center" gap={LOGO_GAP}>
            {/* Terminals draw images above cell text, so the cat would show through an open dialog. */}
            <Show when={!props.covered} fallback={<box width={CAT_COLS} height={CAT_ROWS} flexShrink={0} />}>
              <Cat />
            </Show>
            <Show when={parts().wordmark}>
              <PixelArt art={WORDMARK} palette={wordmarkPalette()} />
            </Show>
          </box>
          <box height={2} />
        </Show>
        <InputBlock {...props.input} width={width()} />
        <box height={1} />
        <box width={width()} flexDirection="row" justifyContent="center">
          <Hints recent={parts().recent} />
        </box>
        <Show when={parts().recent}>
          <box height={1} />
          <RecentList entries={props.recent.entries} selected={props.recent.selected} width={width()} />
        </Show>
      </box>
      <box flexDirection="row" justifyContent="space-between" paddingX={2} flexShrink={0}>
        <text fg={theme.muted}>
          {props.workspace.branch ? `${props.workspace.cwd}  ${props.workspace.branch}` : props.workspace.cwd}
        </text>
        <Show when={props.notice}>{(notice) => <text fg={theme.warning}>{notice()}</text>}</Show>
        <text fg={theme.muted}>{`v${props.workspace.version}`}</text>
      </box>
    </box>
  )
}
