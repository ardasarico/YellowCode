import { type OptimizedBuffer, type Renderable, TextAttributes } from "@opentui/core"

// Reverse video over a renderable's cells, clipped to `clip`, for terminals that cannot show a tinted background.
export function invertCells(target: Renderable, buffer: OptimizedBuffer, clip: Renderable | undefined): void {
  const { attributes } = buffer.buffers
  const top = Math.max(target.y, clip?.y ?? 0, 0)
  const bottom = Math.min(target.y + target.height, clip ? clip.y + clip.height : buffer.height, buffer.height)
  const left = Math.max(target.x, clip?.x ?? 0, 0)
  const right = Math.min(target.x + target.width, clip ? clip.x + clip.width : buffer.width, buffer.width)
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = y * buffer.width + x
      attributes[index] = (attributes[index] ?? 0) | TextAttributes.INVERSE
    }
  }
}
