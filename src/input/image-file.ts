import { imageInfo, NativeImage } from "@opentui/core"
import { Resvg } from "@resvg/resvg-js"
import jpeg from "jpeg-js"
import type { PromptImage } from "../agent/agent.ts"
import { log } from "../log/log.ts"
import type { LoadImage } from "./draft.ts"
import { encodePng, type Pixels } from "./png.ts"

const MAX_SIDE = 2000
const MAX_BYTES = 3.75 * 1024 * 1024

function startsWith(bytes: Uint8Array, prefix: string, at = 0): boolean {
  return Buffer.from(prefix, "latin1").every((byte, index) => bytes[at + index] === byte)
}

function mediaTypeOf(bytes: Uint8Array): PromptImage["mediaType"] | null {
  if (startsWith(bytes, "\x89PNG\r\n\x1a\n")) return "image/png"
  if (startsWith(bytes, "\xff\xd8\xff")) return "image/jpeg"
  if (startsWith(bytes, "GIF8")) return "image/gif"
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp"
  return null
}

// A valid header can hide broken pixel data, which only fails when a frame draws the image.
function decodes(bytes: Uint8Array): boolean {
  let image: NativeImage | undefined
  try {
    image = NativeImage.decode(bytes)
    image.raw()
    return true
  } catch (error) {
    log.warn("image could not be decoded", String(error))
    return false
  } finally {
    image?.dispose()
  }
}

// Tried in order on the image (at most MAX_SIDE) until the JPEG fits: lower quality first, then a shorter long side.
const STEPS = [
  { quality: 80, side: MAX_SIDE },
  { quality: 70, side: MAX_SIDE },
  { quality: 60, side: MAX_SIDE },
  { quality: 50, side: MAX_SIDE },
  { quality: 50, side: 1568 },
  { quality: 50, side: 1200 },
  { quality: 50, side: 1000 },
]

// `bytes` is what the last step still came to.
export class ImageTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`image too large to attach (${(bytes / 1024 / 1024).toFixed(1)} MB, limit 3.75 MB)`)
  }
}

function sizeOf(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    return imageInfo(bytes)
  } catch {
    return null
  }
}

// The decoder refuses pictures over about 25 MP; resvg draws those smaller. It ignores the EXIF orientation, so such a
// photo taken sideways stays sideways. The size is the original's.
function drawSmaller(bytes: Uint8Array, side: number): { png: Uint8Array; width: number; height: number } | null {
  const type = mediaTypeOf(bytes)
  if (type === null) return null
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:${type};base64,${Buffer.from(bytes).toString("base64")}"/></svg>`
  const { width, height } = new Resvg(svg)
  if (!width || !height) return null
  const mode = width >= height ? "width" : "height"
  const value = Math.min(side, Math.max(width, height))
  return { png: new Resvg(svg, { fitTo: { mode, value } }).render().asPng(), width, height }
}

function open(bytes: Uint8Array): NativeImage | null {
  try {
    return NativeImage.decode(bytes)
  } catch {
    const smaller = drawSmaller(bytes, MAX_SIDE)
    return smaller && NativeImage.decode(smaller.png)
  }
}

// Straight-alpha RGBA, at most `side` pixels long, with the rows packed tight.
function pixelsOf(image: NativeImage, side: number): Pixels {
  const longest = Math.max(image.width, image.height)
  const resized =
    longest > side
      ? image.resize({
          width: Math.max(1, Math.round((image.width * side) / longest)),
          height: Math.max(1, Math.round((image.height * side) / longest)),
        })
      : image
  try {
    const raw = resized.raw()
    const row = raw.width * 4
    const data = new Uint8Array(row * raw.height)
    for (let y = 0; y < raw.height; y++) data.set(raw.data.subarray(y * raw.stride, y * raw.stride + row), y * row)
    return { data, width: raw.width, height: raw.height }
  } finally {
    if (resized !== image) resized.dispose()
  }
}

// JPEG has no alpha, so see-through parts go onto white rather than black.
function toJpeg({ data, width, height }: Pixels, quality: number): Uint8Array {
  const flat = Buffer.alloc(data.length)
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3] ?? 255
    for (let channel = 0; channel < 3; channel++)
      flat[at + channel] = Math.round(((data[at + channel] ?? 0) * alpha + 255 * (255 - alpha)) / 255)
    flat[at + 3] = 255
  }
  return jpeg.encode({ data: flat, width, height }, quality).data
}

// A PNG copy at most `side` pixels long, for a picture too large to decode. The size is the original's.
export async function shrunkCopy(
  path: string,
  side: number,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const smaller = drawSmaller(await Bun.file(path).bytes(), side)
  return smaller && { bytes: smaller.png, width: smaller.width, height: smaller.height }
}

// Larger than MAX_SIDE: scaled down, as JPEG for a JPEG and PNG otherwise. Over MAX_BYTES: JPEG steps until it fits.
// `size` is null for a picture the decoder refuses.
function shrink(
  bytes: Uint8Array,
  type: PromptImage["mediaType"],
  size: { width: number; height: number } | null,
): Uint8Array | null {
  const image = open(bytes)
  if (!image) return null
  try {
    const pixels = pixelsOf(image, MAX_SIDE)
    const resized = size === null || Math.max(size.width, size.height) > MAX_SIDE
    let out = resized ? (type === "image/jpeg" ? toJpeg(pixels, 90) : encodePng(pixels)) : bytes
    if (out.length <= MAX_BYTES) return out
    for (const step of STEPS) {
      out = toJpeg(step.side < MAX_SIDE ? pixelsOf(image, step.side) : pixels, step.quality)
      if (out.length <= MAX_BYTES) break
    }
    return out
  } finally {
    image.dispose()
  }
}

// Throws ImageTooLarge when even the smallest step does not fit.
export function fitImage(bytes: Uint8Array): PromptImage | null {
  const type = mediaTypeOf(bytes)
  if (type === null) return null
  try {
    const size = sizeOf(bytes)
    const fits = size !== null && Math.max(size.width, size.height) <= MAX_SIDE && bytes.length <= MAX_BYTES
    const fitted = fits ? bytes : shrink(bytes, type, size)
    if (fitted === null) return null
    const mediaType = mediaTypeOf(fitted)
    if (mediaType === null) return null
    if (fitted.length > MAX_BYTES) {
      log.warn("image too large after shrinking", { bytes: fitted.length })
      throw new ImageTooLarge(fitted.length)
    }
    if (!decodes(fitted)) return null
    return { mediaType, base64: Buffer.from(fitted).toString("base64") }
  } catch (error) {
    if (error instanceof ImageTooLarge) throw error
    log.warn("image could not be fitted", String(error))
    return null
  }
}

export const loadImage: LoadImage = async (path) => {
  let bytes: Uint8Array
  try {
    bytes = await Bun.file(path).bytes()
  } catch (error) {
    log.warn("image file unreadable", { path, error: String(error) })
    return null
  }
  if (mediaTypeOf(bytes) === null) {
    log.warn("image file has an unsupported format", path)
    return null
  }
  return fitImage(bytes)
}
