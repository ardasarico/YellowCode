import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeImage } from "@opentui/core"
import { log } from "../log/log.ts"
import type { OutgoingImage } from "../protocol/outgoing.ts"
import { spawnLimited } from "../spawn.ts"
import type { LoadImage } from "./draft.ts"

const MAX_SIDE = 2000
const MAX_BYTES = 3.75 * 1024 * 1024

const EXTENSIONS: Record<OutgoingImage["mediaType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

function startsWith(bytes: Uint8Array, prefix: string, at = 0): boolean {
  return Buffer.from(prefix, "latin1").every((byte, index) => bytes[at + index] === byte)
}

function mediaTypeOf(bytes: Uint8Array): OutgoingImage["mediaType"] | null {
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

async function sips(args: string[]): Promise<string | null> {
  const result = await spawnLimited(["sips", ...args], { timeoutMs: 20_000 })
  if (result?.code === 0) return result.stdout
  log.warn("sips failed", { args, stderr: result?.stderr ?? "timed out" })
  return null
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

async function pixelSize(file: string): Promise<{ width: number; height: number } | null> {
  const info = await sips(["-g", "pixelWidth", "-g", "pixelHeight", file])
  const width = Number(/pixelWidth: (\d+)/.exec(info ?? "")?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(info ?? "")?.[1])
  return width && height ? { width, height } : null
}

// A PNG copy at most `side` pixels long, for a picture too large to decode. The size is the original's.
export async function shrunkCopy(
  path: string,
  side: number,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const dir = await mkdtemp(join(tmpdir(), "yellowcode-image-"))
  try {
    const size = await pixelSize(path)
    const copy = join(dir, "copy.png")
    if (!size) return null
    const longest = Math.min(side, Math.max(size.width, size.height))
    if ((await sips(["-Z", String(longest), "-s", "format", "png", path, "--out", copy])) === null) return null
    return { bytes: await Bun.file(copy).bytes(), ...size }
  } catch (error) {
    log.warn("image could not be shrunk", String(error))
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function shrink(dir: string, file: string, type: OutgoingImage["mediaType"]): Promise<string | null> {
  const size = await pixelSize(file)
  if (!size) return null
  const side = Math.max(size.width, size.height)
  if (side > MAX_SIDE) {
    // sips reads WebP but cannot write it.
    const extension = type === "image/webp" ? "png" : EXTENSIONS[type]
    const resized = join(dir, `resized.${extension}`)
    const format = type === "image/webp" ? ["-s", "format", "png"] : []
    if ((await sips(["-Z", String(MAX_SIDE), ...format, file, "--out", resized])) === null) return null
    file = resized
  }
  if (Bun.file(file).size <= MAX_BYTES) return file
  const jpeg = join(dir, "smaller.jpg")
  for (const step of STEPS) {
    const resize = step.side < Math.min(side, MAX_SIDE) ? ["-Z", String(step.side)] : []
    const args = [...resize, "-s", "format", "jpeg", "-s", "formatOptions", String(step.quality), file, "--out", jpeg]
    // oxlint-disable-next-line no-await-in-loop
    if ((await sips(args)) === null) return null
    if (Bun.file(jpeg).size <= MAX_BYTES) break
  }
  return jpeg
}

// Throws ImageTooLarge when even the smallest step does not fit.
export async function fitImage(bytes: Uint8Array): Promise<OutgoingImage | null> {
  const type = mediaTypeOf(bytes)
  if (type === null) return null
  const dir = await mkdtemp(join(tmpdir(), "yellowcode-image-"))
  try {
    const source = join(dir, `image.${EXTENSIONS[type]}`)
    await Bun.write(source, bytes)
    const file = await shrink(dir, source, type)
    if (file === null) return null
    const fitted = await Bun.file(file).bytes()
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
  } finally {
    await rm(dir, { recursive: true, force: true })
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
