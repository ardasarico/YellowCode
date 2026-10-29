import { basename, resolve } from "node:path"
import type { ImageRenderable } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import type { ChatImage } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { createDecoded, loadImage } from "../image-label.tsx"
import { blank, type Cell, cellOf, createShown, sameCell, trackImage } from "../images.ts"

// Below this many chat cells an ask leaves its pictures out.
export const PICTURE_MIN_WIDTH = 70

export function askImage(path: string | null | undefined): ChatImage | null {
  if (!path) return null
  const full = resolve(process.cwd(), path)
  return { name: basename(full), mediaType: "", data: null, path: full }
}

// The option's picture when it can be shown, so `z` and the image view skip the rest.
export function shownPicture(path: string | null | undefined): ChatImage | null {
  const image = askImage(path)
  return image && loadImage(image)?.size ? image : null
}

// A picture fitted into `width`×`height` cells, centred; a muted box when there is nothing to show, without its
// border when the caller frames the picture.
export function AskPicture(props: {
  image: ChatImage | null
  width: number
  height: number
  framed?: boolean
  onOpen?: () => void
}) {
  const decoded = createDecoded(() => props.image)
  const [element, setElement] = createSignal<ImageRenderable>()
  const [cell, setCell] = createSignal<Cell | null>(null, { equals: sameCell })
  const size = () => {
    const image = decoded()
    const shape = cell()
    const ratio = shape ? shape.height / shape.width : 2
    const fitted = image && element()?.getFittedSize(props.width, props.height, ratio, image.width, image.height)
    return fitted ?? { width: props.width, height: props.height }
  }
  const shown = createShown(
    decoded,
    cell,
    () => size().width,
    () => size().height,
  )
  return (
    <box
      width={props.width}
      height={props.height}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      onMouseDown={(event) => {
        if (!props.onOpen || !decoded()) return
        event.preventDefault()
        props.onOpen()
      }}
    >
      <Show
        when={decoded()}
        fallback={
          props.framed ? (
            <text fg={theme.faint}>no preview</text>
          ) : (
            <box
              width={props.width}
              height={props.height}
              border
              borderStyle="rounded"
              borderColor={theme.frame}
              alignItems="center"
              justifyContent="center"
            >
              <text fg={theme.faint}>no preview</text>
            </box>
          )
        }
      >
        <Show when={!blank()} fallback={<box width={size().width} height={size().height} />}>
          <image
            ref={(image) => {
              setElement(image)
              trackImage(image)
            }}
            renderBefore={function () {
              setCell(cellOf(this))
            }}
            source={shown()}
            fit="fit"
            width={size().width}
            height={size().height}
          />
        </Show>
      </Show>
    </box>
  )
}
