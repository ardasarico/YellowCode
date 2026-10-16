import { NativeImage, RGBA } from "@opentui/core"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { Agent } from "../session/types.ts"
import { yellow } from "../theme/brand.ts"
import { theme } from "../theme/theme.ts"
import { blank, onBackground, trackImage } from "./images.ts"

const GRAY = RGBA.fromHex("#8A8A8A")

// Digits 1-4 are the toes from left to right, X is the pad.
const PAW = [
  "..22.33..",
  "..22.33..",
  "11.....44",
  "11.XXX.44",
  "..XXXXX..",
  ".XXXXXXX.",
  ".XXXXXXX.",
  "..XX.XX..",
  ".........",
]
const CHECK = [
  ".........",
  "........X",
  ".......XX",
  "......XX.",
  "X....XX..",
  "XX..XX...",
  ".XXXX....",
  "..XX.....",
  ".........",
]
const CROSS = [
  ".........",
  ".XX...XX.",
  "..XX.XX..",
  "...XXX...",
  "...XXX...",
  "..XX.XX..",
  ".XX...XX.",
  ".........",
  ".........",
]

const MARGIN = 1
const MEDIUM_MARGIN = 3
const SCALE = 10
const TOE_MS = 140
// Alpha of a toe by how many steps ago it lit up.
const TRAIL = [255, 140, 70, 70]

type Size = "small" | "medium" | undefined

// A small mark fills one cell, so its canvas is twice as tall as wide with the art centered vertically.
// A medium mark keeps the normal two cells but draws the art smaller inside them.
function draw(art: string[], color: RGBA, alpha: (ch: string) => number, size: Size): NativeImage {
  const [r, g, b] = color.toInts()
  const margin = size === "medium" ? MEDIUM_MARGIN : MARGIN
  const width = (art.length + margin * 2) * SCALE
  const height = size === "small" ? width * 2 : width
  const top = (height - width) / 2
  const pixels = new Uint8Array(width * height * 4)
  art.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? "."
      if (ch === ".") continue
      const pixel = [r, g, b, alpha(ch)]
      for (let sy = 0; sy < SCALE; sy++)
        for (let sx = 0; sx < SCALE; sx++)
          pixels.set(pixel, ((top + (y + margin) * SCALE + sy) * width + (x + margin) * SCALE + sx) * 4)
    }
  })
  return NativeImage.fromRgba(pixels, width, height)
}

const images = new Map<string, NativeImage>()

function cached(key: string, make: () => NativeImage): NativeImage {
  const found = images.get(key)
  if (found) return found
  const made = make()
  images.set(key, made)
  return made
}

const key = (color: RGBA) => color.toInts().join(",")

const mix = (from: number, to: number) => Math.round(from + (to - from) * 0.7)

// Finished marks lean toward the agent color with a little gray, so they stay quieter than running ones.
function tint(color: RGBA): RGBA {
  const [r, g, b] = color.toInts()
  const [gr, gg, gb] = GRAY.toInts()
  return RGBA.fromInts(mix(gr, r), mix(gg, g), mix(gb, b))
}

const checkImage = (color: RGBA, size: Size) =>
  cached(`check:${key(color)}:${size}`, () => draw(CHECK, tint(color), () => 255, size))
const crossImage = (color: RGBA, size: Size) =>
  cached(`cross:${key(color)}:${size}`, () => draw(CROSS, color, () => 255, size))
const stoppedImage = (color: RGBA, size: Size) =>
  cached(`stopped:${key(color)}:${size}`, () => draw(PAW, tint(color), () => 255, size))

function pawFrame(color: RGBA, step: number | null, size: Size): NativeImage {
  return cached(`paw:${key(color)}:${step}:${size}`, () =>
    draw(
      PAW,
      color,
      (ch) => {
        if (step === null || !/[1-4]/.test(ch)) return 255
        return TRAIL[(step - Number(ch) + 5) % 4] ?? 70
      },
      size,
    ),
  )
}

function Mark(props: { source: NativeImage; size: Size; background: RGBA | null }) {
  const width = () => (props.size === "small" ? 1 : 2)
  return (
    <Show when={!blank()} fallback={<box width={width()} height={1} flexShrink={0} />}>
      <image
        ref={trackImage}
        source={onBackground(props.source, props.background)}
        width={width()}
        height={1}
        flexShrink={0}
      />
    </Show>
  )
}

// Every running paw steps with one clock, which runs only while some paw does.
const [toeStep, setToeStep] = createSignal(0)
let runningPaws = 0
let clock: ReturnType<typeof setInterval> | undefined

function stepWithClock(): void {
  runningPaws += 1
  if (runningPaws === 1) clock = setInterval(() => setToeStep((value) => (value + 1) % 4), TOE_MS)
  onCleanup(() => {
    runningPaws -= 1
    if (runningPaws === 0) clearInterval(clock)
  })
}

function Paw(props: { color: RGBA; running: boolean; size?: Size; background?: RGBA | null }) {
  // Each paw starts on its first toe, as if it had a clock of its own.
  const start = toeStep()
  createEffect(() => {
    if (props.running) stepWithClock()
  })
  return (
    <Mark
      source={pawFrame(props.color, props.running ? (toeStep() - start + 4) % 4 : null, props.size)}
      size={props.size}
      background={props.background ?? theme.background}
    />
  )
}

export function AgentMark(props: { color: RGBA; state: Agent["state"]; size?: Size; background?: RGBA | null }) {
  const background = () => props.background ?? theme.background
  const still = () => {
    if (props.state === "completed") return checkImage(props.color, props.size)
    if (props.state === "failed") return crossImage(theme.error, props.size)
    if (props.state === "stopped") return stoppedImage(props.color, props.size)
    return null
  }
  return (
    <Show when={still()} fallback={<Paw color={props.color} running size={props.size} background={background()} />}>
      {(source) => <Mark source={source()} size={props.size} background={background()} />}
    </Show>
  )
}

export function ClaudeMark(props: { running: boolean }) {
  return <Paw color={yellow(true)} running={props.running} />
}

const RING_SIZE = 64
const RING_RADIUS = 0.32 * RING_SIZE
const RING_HALF_WIDTH = 0.066 * RING_SIZE
const RING_STEPS = 32

const coverage = (distance: number) => Math.min(1, Math.max(0, RING_HALF_WIDTH + 0.5 - distance))

// The arc runs clockwise from 12 o'clock with round ends; both parts are antialiased by their distance to the stroke.
function ringImage(color: RGBA, track: RGBA, step: number): NativeImage {
  return cached(`ring:${key(color)}:${key(track)}:${step}`, () => {
    const pixels = new Uint8Array(RING_SIZE * RING_SIZE * 4)
    const center = RING_SIZE / 2
    const sweep = (step / RING_STEPS) * Math.PI * 2
    const end = { x: center + Math.sin(sweep) * RING_RADIUS, y: center - Math.cos(sweep) * RING_RADIUS }
    const [ar, ag, ab] = color.toInts()
    const [tr, tg, tb] = track.toInts()
    for (let y = 0; y < RING_SIZE; y++) {
      for (let x = 0; x < RING_SIZE; x++) {
        const dx = x + 0.5 - center
        const dy = y + 0.5 - center
        const fromCircle = Math.abs(Math.hypot(dx, dy) - RING_RADIUS)
        const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2)
        const fromEnds = Math.min(
          Math.hypot(x + 0.5 - center, y + 0.5 - (center - RING_RADIUS)),
          Math.hypot(x + 0.5 - end.x, y + 0.5 - end.y),
        )
        const arc = step === 0 ? 0 : coverage(step === RING_STEPS || angle <= sweep ? fromCircle : fromEnds)
        const back = coverage(fromCircle) * (1 - arc)
        const alpha = arc + back
        if (alpha === 0) continue
        pixels.set(
          [
            Math.round((ar * arc + tr * back) / alpha),
            Math.round((ag * arc + tg * back) / alpha),
            Math.round((ab * arc + tb * back) / alpha),
            Math.round(alpha * 255),
          ],
          (y * RING_SIZE + x) * 4,
        )
      }
    }
    return NativeImage.fromRgba(pixels, RING_SIZE, RING_SIZE)
  })
}

export function ContextRing(props: { fraction: number; color: RGBA; background: RGBA | null }) {
  const step = () => Math.min(RING_STEPS, Math.max(0, Math.round(props.fraction * RING_STEPS)))
  return (
    <Show when={!blank()} fallback={<box width={2} height={1} flexShrink={0} />}>
      <image
        ref={trackImage}
        source={onBackground(ringImage(props.color, theme.frame, step()), props.background)}
        width={2}
        height={1}
        flexShrink={0}
      />
    </Show>
  )
}
