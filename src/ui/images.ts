import { NativeImage, type RGBA } from "@opentui/core"

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
  const result = NativeImage.fromRgba(pixels, width, height).composite(image)
  byColor.set(key, result)
  return result
}
