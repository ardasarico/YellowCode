import { type OptimizedBuffer, type Renderable, TextAttributes } from "@opentui/core"

type Area = { top: number; bottom: number; left: number; right: number }

const queued: Area[] = []

// Paint hooks cannot read cells, so a hook queues the area and invertQueued flips it once the frame is drawn.
export function invertCells(target: Renderable, clip: Renderable | undefined): void {
  queued.push({
    top: Math.max(target.y, clip?.y ?? 0),
    bottom: Math.min(target.y + target.height, clip ? clip.y + clip.height : Infinity),
    left: Math.max(target.x, clip?.x ?? 0),
    right: Math.min(target.x + target.width, clip ? clip.x + clip.width : Infinity),
  })
}

// Reverse video over the queued areas, for terminals that cannot show a tinted background.
export function invertQueued(buffer: OptimizedBuffer): void {
  const { attributes } = buffer.buffers
  for (const area of queued.splice(0)) {
    for (let y = Math.max(area.top, 0); y < Math.min(area.bottom, buffer.height); y++) {
      for (let x = Math.max(area.left, 0); x < Math.min(area.right, buffer.width); x++) {
        const index = y * buffer.width + x
        attributes[index] = (attributes[index] ?? 0) | TextAttributes.INVERSE
      }
    }
  }
}
