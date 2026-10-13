import { type ImageRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { onBackground, SCRIM, tracked, underScrim } from "../images.ts"

type Rect = { x: number; y: number; width: number; height: number }

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x)
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)
  return { x, y, width, height }
}

const area = (rect: Rect) => rect.width * rect.height

// The image's box as far as it is on screen: every ancestor that clips its children clips it too.
function shownRect(element: ImageRenderable): Rect {
  let rect: Rect = { x: element.screenX, y: element.screenY, width: element.width, height: element.height }
  for (let parent = element.parent; parent; parent = parent.parent) {
    if (parent.overflow === "visible") continue
    rect = intersect(rect, { x: parent.screenX, y: parent.screenY, width: parent.width, height: parent.height })
  }
  return rect
}

// The largest part of `rect` the panel leaves free: a terminal image is drawn above cells, so it must not reach it.
function besidePanel(rect: Rect, panel: Rect): Rect {
  if (area(intersect(rect, panel)) === 0) return rect
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  const panelRight = panel.x + panel.width
  const panelBottom = panel.y + panel.height
  const parts: Rect[] = [
    { x: rect.x, y: rect.y, width: rect.width, height: panel.y - rect.y },
    { x: rect.x, y: panelBottom, width: rect.width, height: bottom - panelBottom },
    { x: rect.x, y: rect.y, width: panel.x - rect.x, height: rect.height },
    { x: panelRight, y: rect.y, width: right - panelRight, height: rect.height },
  ].map((part) => intersect(part, rect))
  return parts.reduce((best, part) => (area(part) > area(best) ? part : best))
}

function blend(color: RGBA): RGBA {
  const [r, g, b] = color.toInts()
  const [sr, sg, sb, sa] = SCRIM.toInts()
  const amount = sa / 255
  const mix = (from: number, to: number) => Math.round(from * (1 - amount) + to * amount)
  return RGBA.fromInts(mix(r, sr), mix(g, sg), mix(b, sb))
}

const base = () => theme.background ?? theme.canvas

// The dialog's scrim wipes the images under it, so they are drawn again above it, dimmed like the cells around them.
export function DimmedImages(props: { panel: Rect }) {
  const dimensions = useTerminalDimensions()
  return (
    <For each={tracked()}>
      {(element) => {
        const box = createMemo(() => {
          dimensions()
          return { x: element.screenX, y: element.screenY, width: element.width, height: element.height }
        })
        const part = () => besidePanel(shownRect(element), props.panel)
        const source = () => (element.image ? underScrim(onBackground(element.image, base())) : undefined)
        return (
          <Show when={area(part()) > 0 && source()}>
            {(image) => (
              <box
                position="absolute"
                left={part().x}
                top={part().y}
                width={part().width}
                height={part().height}
                zIndex={10}
                overflow="hidden"
                backgroundColor={blend(base())}
              >
                <image
                  position="absolute"
                  left={box().x - part().x}
                  top={box().y - part().y}
                  width={box().width}
                  height={box().height}
                  fit={element.fit}
                  source={image()}
                />
              </box>
            )}
          </Show>
        )
      }}
    </For>
  )
}
