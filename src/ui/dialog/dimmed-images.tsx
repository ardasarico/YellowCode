import { type ImageRenderable, type NativeImage, RGBA } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
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

// The parts of `rect` the panel leaves free, without overlap: a terminal image is drawn above cells, so it must not
// reach the panel. Above and below take the whole width, left and right the rows beside the panel.
function besidePanel(rect: Rect, panel: Rect): Rect[] {
  if (area(rect) === 0) return []
  if (area(intersect(rect, panel)) === 0) return [rect]
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  const panelRight = panel.x + panel.width
  const panelBottom = panel.y + panel.height
  const top = Math.max(rect.y, panel.y)
  const middle = Math.min(bottom, panelBottom) - top
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: panel.y - rect.y },
    { x: rect.x, y: panelBottom, width: rect.width, height: bottom - panelBottom },
    { x: rect.x, y: top, width: panel.x - rect.x, height: middle },
    { x: panelRight, y: top, width: right - panelRight, height: middle },
  ]
    .map((part) => intersect(part, rect))
    .filter((part) => area(part) > 0)
}

function blend(color: RGBA): RGBA {
  const [r, g, b] = color.toInts()
  const [sr, sg, sb, sa] = SCRIM.toInts()
  const amount = sa / 255
  const mix = (from: number, to: number) => Math.round(from * (1 - amount) + to * amount)
  return RGBA.fromInts(mix(r, sr), mix(g, sg), mix(b, sb))
}

const base = () => theme.background ?? theme.canvas

type Place = { box: Rect; parts: Rect[]; image: NativeImage | null }

const samePlace = (a: Place, b: Place) =>
  a.image === b.image && JSON.stringify([a.box, a.parts]) === JSON.stringify([b.box, b.parts])

// The dialog's scrim wipes the images under it, so they are drawn again above it, dimmed like the cells around them.
// The rows behind a dialog still move (a turn goes on, a setting changes them), and nothing tells when a renderable
// was laid out elsewhere, so every image's place is read again in every frame.
export function DimmedImages(props: { panel: Rect }) {
  const [frame, setFrame] = createSignal(0)
  return (
    <>
      <box position="absolute" left={0} top={0} width={1} height={1} renderAfter={() => setFrame(frame() + 1)} />
      <For each={tracked()}>
        {(element) => {
          const place = createMemo(
            (): Place => {
              frame()
              return {
                box: { x: element.screenX, y: element.screenY, width: element.width, height: element.height },
                parts: besidePanel(shownRect(element), props.panel),
                image: element.image,
              }
            },
            undefined,
            { equals: samePlace },
          )
          const source = () => {
            const { image } = place()
            if (!image) return undefined
            // Drawn as blocks, the cells show through where the image is transparent, as they do in the image itself.
            return underScrim(element.effectiveProtocol === "blocks" ? image : onBackground(image, base()))
          }
          return (
            <Show when={source()}>
              {(image) => (
                <For each={place().parts}>
                  {(part) => (
                    <box
                      position="absolute"
                      left={part.x}
                      top={part.y}
                      width={part.width}
                      height={part.height}
                      zIndex={10}
                      overflow="hidden"
                      backgroundColor={blend(base())}
                    >
                      <image
                        position="absolute"
                        left={place().box.x - part.x}
                        top={place().box.y - part.y}
                        width={place().box.width}
                        height={place().box.height}
                        fit={element.fit}
                        source={image()}
                      />
                    </box>
                  )}
                </For>
              )}
            </Show>
          )
        }}
      </For>
    </>
  )
}
