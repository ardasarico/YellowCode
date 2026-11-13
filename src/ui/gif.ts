export type GifFrame = { pixels: Uint8Array; delay: number }
export type Gif = { width: number; height: number; frames: GifFrame[] }

// Every frame is kept as a whole canvas, so a long or large GIF stays still past this.
const MAX_PIXEL_BYTES = 96 * 1024 * 1024
// Browsers play a delay this short as 100 ms.
const SHORTEST_DELAY = 20

export const isGif = (bytes: Uint8Array) =>
  bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38

// The frames of an animated GIF, composed as they are shown. null for a still one or one that does not read.
export function decodeGif(bytes: Uint8Array): Gif | null {
  try {
    return frames(bytes)
  } catch {
    return null
  }
}

function frames(bytes: Uint8Array): Gif | null {
  if (!isGif(bytes)) return null
  let at = 6
  const u8 = () => {
    if (at >= bytes.length) throw new Error("GIF ends early")
    return bytes[at++] ?? 0
  }
  const u16 = () => u8() | (u8() << 8)
  const palette = (size: number) => {
    const colors = bytes.subarray(at, at + size * 3)
    at += size * 3
    return colors
  }
  const subBlocks = () => {
    const parts: Uint8Array[] = []
    for (let size = u8(); size > 0; size = u8()) {
      parts.push(bytes.subarray(at, at + size))
      at += size
    }
    return parts
  }

  const width = u16()
  const height = u16()
  const screen = u8()
  at += 2
  const global = screen & 0x80 ? palette(2 << (screen & 7)) : null
  if (width === 0 || height === 0) return null
  const frameBytes = width * height * 4
  const canvas = new Uint8Array(frameBytes)
  const result: GifFrame[] = []
  let delay = 0
  let disposal = 0
  let transparent = -1

  while (at < bytes.length) {
    const block = u8()
    if (block === 0x3b) break
    if (block === 0x21) {
      const label = u8()
      const parts = subBlocks()
      const control = parts[0]
      if (label === 0xf9 && control && control.length >= 4) {
        const flags = control[0] ?? 0
        disposal = (flags >> 2) & 7
        delay = ((control[1] ?? 0) | ((control[2] ?? 0) << 8)) * 10
        transparent = flags & 1 ? (control[3] ?? 0) : -1
      }
      continue
    }
    if (block !== 0x2c) return null
    const left = u16()
    const top = u16()
    const frameWidth = u16()
    const frameHeight = u16()
    const flags = u8()
    const colors = flags & 0x80 ? palette(2 << (flags & 7)) : global
    const minSize = u8()
    const data = concat(subBlocks())
    if ((result.length + 1) * frameBytes > MAX_PIXEL_BYTES) return null
    const indices = lzw(data, minSize, frameWidth * frameHeight)
    const rows = flags & 0x40 ? interlacedRows(frameHeight) : null
    const saved = disposal === 3 ? canvas.slice() : null
    if (colors) {
      for (let y = 0; y < frameHeight; y++) {
        const canvasY = top + (rows ? (rows[y] ?? 0) : y)
        if (canvasY >= height) continue
        for (let x = 0; x < frameWidth; x++) {
          const canvasX = left + x
          if (canvasX >= width) break
          const index = indices[y * frameWidth + x] ?? 0
          if (index === transparent || index * 3 + 2 >= colors.length) continue
          const to = (canvasY * width + canvasX) * 4
          canvas[to] = colors[index * 3] ?? 0
          canvas[to + 1] = colors[index * 3 + 1] ?? 0
          canvas[to + 2] = colors[index * 3 + 2] ?? 0
          canvas[to + 3] = 255
        }
      }
    }
    result.push({ pixels: canvas.slice(), delay: delay < SHORTEST_DELAY ? 100 : delay })
    if (disposal === 2) {
      for (let y = top; y < Math.min(height, top + frameHeight); y++) {
        const from = (y * width + left) * 4
        canvas.fill(0, from, from + Math.max(0, Math.min(frameWidth, width - left)) * 4)
      }
    } else if (saved) canvas.set(saved)
    delay = 0
    disposal = 0
    transparent = -1
  }
  return result.length > 1 ? { width, height, frames: result } : null
}

function concat(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

// Where each stored row goes: every 8th from 0, every 8th from 4, every 4th from 2, then every 2nd from 1.
function interlacedRows(height: number): number[] {
  const rows: number[] = []
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const)
    for (let y = start; y < height; y += step) rows.push(y)
  return rows
}

function lzw(data: Uint8Array, minSize: number, count: number): Uint8Array {
  const out = new Uint8Array(count)
  const clear = 1 << minSize
  const end = clear + 1
  const prefix = new Int16Array(4096)
  const suffix = new Uint8Array(4096)
  const first = new Uint8Array(4096)
  const length = new Uint16Array(4096)
  for (let code = 0; code < clear; code++) {
    prefix[code] = -1
    suffix[code] = code
    first[code] = code
    length[code] = 1
  }
  let size = minSize + 1
  let next = end + 1
  let previous = -1
  let bits = 0
  let buffer = 0
  let read = 0
  let written = 0
  while (written < count) {
    while (bits < size) {
      if (read >= data.length) return out
      buffer |= (data[read++] ?? 0) << bits
      bits += 8
    }
    const code = buffer & ((1 << size) - 1)
    buffer >>>= size
    bits -= size
    if (code === clear) {
      size = minSize + 1
      next = end + 1
      previous = -1
      continue
    }
    if (code === end) break
    if (code > next || (code === next && previous === -1)) break
    if (previous !== -1 && next < 4096) {
      prefix[next] = previous
      suffix[next] = code === next ? (first[previous] ?? 0) : (first[code] ?? 0)
      first[next] = first[previous] ?? 0
      length[next] = (length[previous] ?? 0) + 1
      next++
      if (next === 1 << size && size < 12) size++
    } else if (code === next) break
    let at = code
    for (let k = (length[code] ?? 1) - 1; k >= 0; k--) {
      if (written + k < count) out[written + k] = suffix[at] ?? 0
      at = prefix[at] ?? -1
    }
    written += length[code] ?? 1
    previous = code
  }
  return out
}
