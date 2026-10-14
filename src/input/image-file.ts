import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "../log/log.ts"
import type { OutgoingImage } from "../protocol/outgoing.ts"
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

async function sips(args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["sips", ...args], { stdout: "pipe", stderr: "pipe" })
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code === 0) return output
  log.warn("sips failed", { args, stderr: await new Response(proc.stderr).text() })
  return null
}

async function shrink(dir: string, file: string, type: OutgoingImage["mediaType"]): Promise<string | null> {
  const info = await sips(["-g", "pixelWidth", "-g", "pixelHeight", file])
  if (info === null) return null
  const side = Math.max(...[...info.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((match) => Number(match[1])))
  if (side > MAX_SIDE) {
    // sips reads WebP but cannot write it.
    const extension = type === "image/webp" ? "png" : EXTENSIONS[type]
    const resized = join(dir, `resized.${extension}`)
    const format = type === "image/webp" ? ["-s", "format", "png"] : []
    if ((await sips(["-Z", String(MAX_SIDE), ...format, file, "--out", resized])) === null) return null
    file = resized
  }
  if (Bun.file(file).size > MAX_BYTES) {
    const jpeg = join(dir, "smaller.jpg")
    if ((await sips(["-s", "format", "jpeg", "-s", "formatOptions", "80", file, "--out", jpeg])) === null) return null
    file = jpeg
  }
  return file
}

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
    if (mediaType === null || fitted.length > MAX_BYTES) {
      log.warn("image too large after shrinking", { bytes: fitted.length })
      return null
    }
    return { mediaType, base64: Buffer.from(fitted).toString("base64") }
  } catch (error) {
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
