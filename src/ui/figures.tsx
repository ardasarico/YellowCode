import { NativeImage, RGBA } from "@opentui/core"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { Agent } from "../session/types.ts"
import { yellow } from "../theme/brand.ts"
import { theme } from "../theme/theme.ts"
import { onBackground } from "./images.ts"

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
const SCALE = 10
const TOE_MS = 140
// Alpha of a toe by how many steps ago it lit up.
const TRAIL = [255, 140, 70, 70]

function draw(art: string[], color: RGBA, alpha: (ch: string) => number): NativeImage {
  const [r, g, b] = color.toInts()
  const width = (art.length + MARGIN * 2) * SCALE
  const pixels = new Uint8Array(width * width * 4)
  art.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? "."
      if (ch === ".") continue
      const pixel = [r, g, b, alpha(ch)]
      for (let sy = 0; sy < SCALE; sy++)
        for (let sx = 0; sx < SCALE; sx++)
          pixels.set(pixel, (((y + MARGIN) * SCALE + sy) * width + (x + MARGIN) * SCALE + sx) * 4)
    }
  })
  return NativeImage.fromRgba(pixels, width, width)
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

const mix = (from: number, to: number) => Math.round(from + (to - from) * 0.35)

// Finished marks sit between gray and the agent color, so they stay quiet next to running ones.
function tint(color: RGBA): RGBA {
  const [r, g, b] = color.toInts()
  const [gr, gg, gb] = GRAY.toInts()
  return RGBA.fromInts(mix(gr, r), mix(gg, g), mix(gb, b))
}

const checkImage = (color: RGBA) => cached(`check:${key(color)}`, () => draw(CHECK, tint(color), () => 255))
const crossImage = (color: RGBA) => cached(`cross:${key(color)}`, () => draw(CROSS, color, () => 255))
const stoppedImage = (color: RGBA) => cached(`stopped:${key(color)}`, () => draw(PAW, tint(color), () => 255))

function pawFrame(color: RGBA, step: number | null): NativeImage {
  return cached(`paw:${key(color)}:${step}`, () =>
    draw(PAW, color, (ch) => {
      if (step === null || !/[1-4]/.test(ch)) return 255
      return TRAIL[(step - Number(ch) + 5) % 4] ?? 70
    }),
  )
}

function Paw(props: { color: RGBA; running: boolean }) {
  const [step, setStep] = createSignal(0)
  createEffect(() => {
    if (!props.running) return
    const timer = setInterval(() => setStep((value) => (value + 1) % 4), TOE_MS)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <image
      source={onBackground(pawFrame(props.color, props.running ? step() : null), theme.background)}
      width={2}
      height={1}
      flexShrink={0}
    />
  )
}

export function AgentMark(props: { color: RGBA; state: Agent["state"] }) {
  const still = () => {
    if (props.state === "completed") return checkImage(props.color)
    if (props.state === "failed") return crossImage(theme.error)
    if (props.state === "stopped") return stoppedImage(props.color)
    return null
  }
  return (
    <Show when={still()} fallback={<Paw color={props.color} running />}>
      {(source) => <image source={onBackground(source(), theme.background)} width={2} height={1} flexShrink={0} />}
    </Show>
  )
}

export function ClaudeMark(props: { running: boolean }) {
  return <Paw color={yellow(true)} running={props.running} />
}
