import { type ImageRenderable, NativeImage, type Renderable, RGBA } from "@opentui/core"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { theme } from "../theme/theme.ts"

// A dialog's layers wipe the images under them, so while one is open it draws the tracked images again, dimmed, above
// its scrim. Without a scrim (no known colors) an image gives way to an empty box of its size instead.
const [covered, setCovered] = createSignal(false)
// Changed in place, since copying the list for every image made mounting thousands of them quadratic.
const [tracked, setTracked] = createSignal<ImageRenderable[]>([], { equals: false })
export { covered, setCovered, tracked }

export const blank = () => covered() && !theme.dim

export function trackImage(element: ImageRenderable): void {
  setTracked((list) => {
    list.push(element)
    return list
  })
  onCleanup(() =>
    setTracked((list) => {
      const index = list.indexOf(element)
      if (index >= 0) list.splice(index, 1)
      return list
    }),
  )
}

export type Cell = { width: number; height: number }

// One cell's size in pixels. The terminal reports it only after startup, and again after every resize.
export function cellOf(element: Renderable): Cell | null {
  const { resolution, terminalWidth, terminalHeight } = element.ctx
  if (!resolution?.width || !resolution.height || !terminalWidth || !terminalHeight) return null
  return { width: resolution.width / terminalWidth, height: resolution.height / terminalHeight }
}

export const sameCell = (a: Cell | null, b: Cell | null) => a?.width === b?.width && a?.height === b?.height

// OpenTUI shrinks an image with 4× the pixels it is shown with on its own, but again whenever its visible part changes,
// so a scrolled image would be sent to the terminal at every step. Shrunk once here, it is sent once.
export function createShown(
  image: () => NativeImage | undefined,
  cell: () => Cell | null,
  columns: () => number,
  rows: () => number,
): () => NativeImage | undefined {
  return createMemo(() => {
    const source = image()
    const size = cell()
    if (!source || !size || !columns() || !rows()) return source
    const width = Math.round(columns() * size.width)
    const height = Math.round(rows() * size.height)
    if (source.width * source.height < width * height * 4) return source
    const shrunk = source.resize({ width, height, kernel: "area" })
    onCleanup(() => shrunk.dispose())
    return shrunk
  })
}

// The color a dialog lays over the app.
export const SCRIM = RGBA.fromValues(6 / 255, 7 / 255, 12 / 255, 0.75)

const scrimmed = new WeakMap<NativeImage, NativeImage>()

// The image as it looks under the scrim. Transparent pixels stay transparent.
export function underScrim(image: NativeImage): NativeImage {
  const found = scrimmed.get(image)
  if (found) return found
  const { width, height } = image
  const pixels = new Uint8Array(width * height * 4)
  image.copyTo(pixels)
  const [r, g, b, a] = SCRIM.toInts()
  const amount = a / 255
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue
    pixels[index] = (pixels[index] ?? 0) * (1 - amount) + r * amount
    pixels[index + 1] = (pixels[index + 1] ?? 0) * (1 - amount) + g * amount
    pixels[index + 2] = (pixels[index + 2] ?? 0) * (1 - amount) + b * amount
  }
  const result = NativeImage.fromRgba(pixels, width, height)
  scrimmed.set(image, result)
  return result
}

const flattened = new WeakMap<NativeImage, Map<string, NativeImage>>()

// Terminals show an image's transparent pixels over their own default background, so a painted theme bakes its own in.
export function onBackground(image: NativeImage, background: RGBA | null): NativeImage {
  if (!background) return image
  const key = background.toInts().join(",")
  const byColor = flattened.get(image) ?? new Map<string, NativeImage>()
  flattened.set(image, byColor)
  const found = byColor.get(key)
  if (found) return found
  const { width, height } = image.info()
  const pixels = new Uint8Array(width * height * 4)
  const [r, g, b] = background.toInts()
  for (let index = 0; index < pixels.length; index += 4) pixels.set([r, g, b, 255], index)
  const base = NativeImage.fromRgba(pixels, width, height)
  const result = base.composite(image)
  base.dispose()
  byColor.set(key, result)
  return result
}
