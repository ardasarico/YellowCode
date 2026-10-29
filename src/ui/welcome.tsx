import { NativeImage, RGBA } from "@opentui/core"
import { Index, Match, Show, Switch } from "solid-js"
import type { SessionEntry } from "../agent/sessions.ts"
import { yellow } from "../theme/brand.ts"
import { theme } from "../theme/theme.ts"
import { mix } from "./color.ts"
import { cut, cutPath } from "./format.ts"
import type { Span } from "./notice.ts"
import { blank, onBackground, trackImage } from "./images.ts"
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
  ["/", "commands"],
  ["↓", "recent"],
  ["⇧+↑↓", "effort"],
  ["⇧+←→", "model"],
]

const HINT_GAP = "   "

// The hints stay on one row; the ones that do not fit drop from the end.
function hintParts(recent: boolean, room: number) {
  const hints = HINTS.filter(([key]) => recent || key !== "↓")
  const width = (count: number) =>
    hints.slice(0, count).reduce((sum, [key, label]) => sum + Bun.stringWidth(`${key} ${label}`), 0) +
    HINT_GAP.length * Math.max(0, count - 1)
  let count = hints.length
  while (count > 0 && width(count) > room) count--
  return hints.slice(0, count).flatMap(([key, label], index) => [
    { text: `${index === 0 ? "" : HINT_GAP}${key}`, isKey: true },
    { text: ` ${label}`, isKey: false },
  ])
}

type LogoStep = "full" | "cat" | "none"

const SMALL_COLS = 5
const SMALL_ROWS = 2
const BASE_ROWS = BLOCK_ROWS + 1 + 1

// Each step counts its blank rows under the logo too.
const LOGO_STEPS: { step: LogoStep; rows: number; width: number }[] = [
  { step: "full", rows: CAT_ROWS + 2, width: CAT_COLS + LOGO_GAP + (WORDMARK[0]?.length ?? 0) },
  { step: "cat", rows: SMALL_ROWS + 1, width: SMALL_COLS },
]

// The recent sessions (a blank row, their heading and the rows) are placed first, and the logo takes the largest step
// that fits what is left. Once there is no room for them even without a logo, the logo stays off as well.
function welcomeParts(
  width: number,
  height: number,
  recent: number,
): { logo: LogoStep; rows: number; recent: boolean } {
  const recentRows = recent > 0 ? 2 + recent : 0
  const left = height - BASE_ROWS - recentRows
  if (left < 0 && recent > 0) return { logo: "none", rows: 0, recent: false }
  const found = LOGO_STEPS.find((step) => step.rows <= left && step.width <= width)
  return { logo: found?.step ?? "none", rows: found?.rows ?? 0, recent: recent > 0 }
}

const blockWidth = (width: number) => Math.max(0, Math.min(BLOCK_WIDTH, width - 4))

// What the welcome screen shows in a terminal of this size; the bottom row holds the workspace line, with a blank row
// above it.
export function welcomeLayout(width: number, height: number, recent: number) {
  return welcomeParts(blockWidth(width), height - 2, recent)
}

const BOTTOM_GAP = 2
const fit = (text: string, room: number) => (room > 0 ? cut(text, room) : "")

// The notice is cut first and kept, on the right before the version; the path is cut from its start to what is left,
// and the version goes once the path would lose its last folder.
function bottomRow(workspace: Workspace, notice: string, room: number) {
  const version = `v${workspace.version}`
  const branch = workspace.branch ? `${" ".repeat(BOTTOM_GAP)}${workspace.branch}` : ""
  const shownNotice = fit(notice, room)
  const left = room - (shownNotice ? Bun.stringWidth(shownNotice) + BOTTOM_GAP : 0)
  const versionRoom = Bun.stringWidth(version) + BOTTOM_GAP
  const shortest = Math.min(Bun.stringWidth(workspace.cwd), Bun.stringWidth(`…/${workspace.cwd.split("/").pop()}`))
  const withVersion = shortest + Bun.stringWidth(branch) + versionRoom <= left
  const pathRoom = (withVersion ? left - versionRoom : left) - Bun.stringWidth(branch)
  const shownWorkspace = pathRoom > 0 ? cutPath(workspace.cwd, pathRoom) + branch : cutPath(workspace.cwd, left)
  const shownVersion = withVersion ? version : ""
  const after = shownNotice && shownVersion ? BOTTOM_GAP : 0
  const before = Math.max(
    0,
    room - Bun.stringWidth(shownWorkspace) - Bun.stringWidth(shownNotice) - after - Bun.stringWidth(shownVersion),
  )
  return { workspace: shownWorkspace, notice: shownNotice, version: shownVersion, before, after }
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
function Cat(props: { width: number; height: number }) {
  const tick = useTicker(() => true, TICK_MS)
  const source = () => {
    const t = tick() * TICK_MS
    return catImage(t % 3600 < 140 || (t % 11000 >= 300 && t % 11000 < 440), t % 2400 < 500)
  }
  return (
    <image
      ref={trackImage}
      source={onBackground(source(), theme.background)}
      width={props.width}
      height={props.height}
      fit="fit"
      flexShrink={0}
    />
  )
}

export function CatOrBlank(props: { width: number; height: number }) {
  return (
    <Show when={!blank()} fallback={<box width={props.width} height={props.height} flexShrink={0} />}>
      <Cat width={props.width} height={props.height} />
    </Show>
  )
}

function Hints(props: { recent: boolean; width: number }) {
  return (
    <text wrapMode="none">
      <Index each={hintParts(props.recent, props.width)}>
        {(part) => <span style={{ fg: part().isKey ? theme.text : theme.muted }}>{part().text}</span>}
      </Index>
    </text>
  )
}

const WHITE = RGBA.fromInts(255, 255, 255)
const BLACK = RGBA.fromInts(0, 0, 0)

const brand = (hex: string) => (theme.rgb ? RGBA.fromHex(hex) : yellow(false))

// Three tones per word, light at the top and deep at the bottom; the yellow ones are the cat's own.
export function wordmarkPalette(): Record<string, RGBA> {
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
  notice: Span | null
  onNotice?: (() => void) | undefined
  recent: { entries: SessionEntry[]; selected: number | null }
  width: number
  height: number
}) {
  const width = () => blockWidth(props.width)
  const parts = () => welcomeLayout(props.width, props.height, props.recent.entries.length)
  const bottom = () => bottomRow(props.workspace, props.notice?.text ?? "", props.width - 4)
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
        <Switch>
          <Match when={parts().logo === "full"}>
            <box flexDirection="row" alignItems="center" gap={LOGO_GAP}>
              <CatOrBlank width={CAT_COLS} height={CAT_ROWS} />
              <PixelArt art={WORDMARK} palette={wordmarkPalette()} />
            </box>
            <box height={2} />
          </Match>
          <Match when={parts().logo === "cat"}>
            <CatOrBlank width={SMALL_COLS} height={SMALL_ROWS} />
            <box height={1} />
          </Match>
        </Switch>
        <InputBlock {...props.input} width={width()} />
        <box height={1} />
        <box width={width()} flexDirection="row" justifyContent="center">
          <Hints recent={parts().recent} width={width()} />
        </box>
        <Show when={parts().recent}>
          <box height={1} />
          <RecentList entries={props.recent.entries} selected={props.recent.selected} width={width()} />
        </Show>
      </box>
      <box height={1} flexShrink={0} />
      <box
        paddingX={2}
        height={1}
        flexShrink={0}
        onMouseDown={(event) => {
          const start = 2 + Bun.stringWidth(bottom().workspace) + bottom().before
          if (props.onNotice && event.x >= start && event.x < start + Bun.stringWidth(bottom().notice)) props.onNotice()
        }}
      >
        <text wrapMode="none">
          <span style={{ fg: theme.muted }}>{bottom().workspace}</span>
          {" ".repeat(bottom().before)}
          <span style={{ fg: props.notice?.fg, bold: props.notice?.bold }}>{bottom().notice}</span>
          {" ".repeat(bottom().after)}
          <span style={{ fg: theme.muted }}>{bottom().version}</span>
        </text>
      </box>
    </box>
  )
}
